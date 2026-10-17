import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KeelConfig } from '../config.js';
import { keelHome } from '../core/store.js';
import { canonicalPath } from '../policy/policy.js';
import { anyGlobMatch } from '../util/glob.js';

export type SandboxKind = 'seatbelt' | 'bwrap';

let probed: SandboxKind | null | undefined;

/** 探测本机可用的 OS 沙箱（结果按进程缓存）：macOS seatbelt / Linux bubblewrap */
export function detectSandbox(): SandboxKind | null {
  if (probed !== undefined) return probed;
  const ok = (cmd: string, args: string[]) => {
    try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { return false; }
  };
  probed = process.platform === 'darwin' && ok('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']) ? 'seatbelt'
    : process.platform === 'linux' && ok('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '/bin/true']) ? 'bwrap'
    : null;
  return probed;
}

/** 测试用：覆盖探测结果（undefined = 恢复真实探测） */
export function setSandboxProbe(kind: SandboxKind | null | undefined): void {
  probed = kind;
}

/** 本次执行实际使用的沙箱；mode=off 返回 null */
export function sandboxFor(cfg: KeelConfig): SandboxKind | null {
  return cfg.sandbox.mode === 'off' ? null : detectSandbox();
}

/** .git 需要被 git 自己读到：沙箱里对它只禁写，其余 denyPaths 读写都禁 */
const isGitGlob = (glob: string) => /^(\*\*\/)?\.git(\/|$)/.test(glob);

function ereEscape(s: string): string {
  return s.replace(/[.[\]()*+?{}|^$\\]/g, '\\$&');
}

/** glob → seatbelt 用的 POSIX ERE，语义对齐 globMatch：无 "/" 的模式匹配任意层级，匹配目录时覆盖其后代 */
export function globToEre(root: string, glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += ereEscape(c);
  }
  const prefix = glob.startsWith('/') ? '' : `${ereEscape(root)}/${glob.includes('/') ? '' : '(.*/)?'}`;
  return `^${prefix}${re}(/.*)?$`;
}

function sbString(s: string): string {
  if (/["\n\\]/.test(s)) throw new Error(`沙箱不支持含引号/反斜杠/换行的路径: ${s}`);
  return `"${s}"`;
}

function sbRegex(re: string): string {
  if (/["\n]/.test(re)) throw new Error(`沙箱不支持含引号/换行的路径模式: ${re}`);
  return `(regex #"${re}")`;
}

function tempRoots(): string[] {
  const tmp = canonicalPath(os.tmpdir());
  // macOS 的 per-user 临时目录形如 /private/var/folders/xx/yyy/T，同级 C/ 是编译器等工具的缓存目录
  const roots = [tmp, path.basename(tmp) === 'T' ? path.dirname(tmp) : tmp, canonicalPath('/tmp')];
  return [...new Set(roots)];
}

/** macOS seatbelt 配置：默认放行，然后收紧写入/读取/外网。SBPL 后写的规则优先。 */
export function seatbeltProfile(cfg: KeelConfig, cwd: string): string {
  const ws = canonicalPath(path.resolve(cwd));
  const { policy, sandbox } = cfg;
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${[...tempRoots(), ...sandbox.writablePaths.map((p) => canonicalPath(p))].map((p) => `(subpath ${sbString(p)})`).join(' ')}`
      + ' (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))',
  ];
  if (policy.writePaths.length) {
    lines.push(`(deny file-write* (subpath ${sbString(ws)}))`);
    lines.push(`(allow file-write* ${policy.writePaths.map((g) => sbRegex(globToEre(ws, g))).join(' ')})`);
  } else {
    lines.push(`(allow file-write* (subpath ${sbString(ws)}))`);
  }
  const writeDeny = [...policy.protectPaths, ...policy.denyPaths.filter(isGitGlob)];
  const readDeny = policy.denyPaths.filter((g) => !isGitGlob(g));
  if (writeDeny.length) lines.push(`(deny file-write* ${writeDeny.map((g) => sbRegex(globToEre(ws, g))).join(' ')})`);
  if (readDeny.length) lines.push(`(deny file-read* file-write* ${readDeny.map((g) => sbRegex(globToEre(ws, g))).join(' ')})`);
  // 事件库 = 审计记录：沙箱内既读不到其它会话，也改不了自己的历史
  lines.push(`(deny file-read* file-write* (subpath ${sbString(canonicalPath(keelHome()))}))`);
  if (!sandbox.network) {
    lines.push('(deny network-outbound (remote ip))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
  }
  return lines.join('\n');
}

/** Linux 下 bind mount 只能作用于已存在的路径：按 glob 展开工作目录内的现有文件 */
function expandGlobs(ws: string, globs: string[]): string[] {
  if (!globs.length) return [];
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= 5000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const abs = path.join(dir, d.name);
      const rel = path.relative(ws, abs);
      // "dir/**" 也覆盖目录本身：整目录挂载，目录里之后新建的文件同样受约束
      if (anyGlobMatch(globs, rel) || (d.isDirectory() && anyGlobMatch(globs, `${rel}/`))) { out.push(abs); continue; }
      if (d.isDirectory() && !d.isSymbolicLink() && d.name !== 'node_modules') visit(abs, depth + 1);
    }
  };
  visit(ws, 0);
  return out;
}

/** Linux bubblewrap 参数：根目录只读挂载，工作目录/临时目录可写，再叠加保护与遮蔽 */
export function bwrapArgs(cfg: KeelConfig, cwd: string): string[] {
  const ws = canonicalPath(path.resolve(cwd));
  const { policy, sandbox } = cfg;
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  for (const p of [...tempRoots(), ...sandbox.writablePaths.map((x) => canonicalPath(x))]) if (fs.existsSync(p)) args.push('--bind', p, p);
  if (policy.writePaths.length) for (const p of expandGlobs(ws, policy.writePaths)) args.push('--bind', p, p);
  else args.push('--bind', ws, ws);
  for (const p of expandGlobs(ws, [...policy.protectPaths, ...policy.denyPaths.filter(isGitGlob)])) args.push('--ro-bind', p, p);
  for (const p of expandGlobs(ws, policy.denyPaths.filter((g) => !isGitGlob(g)))) {
    if (fs.statSync(p).isDirectory()) args.push('--tmpfs', p);
    // bwrap 的 bind 挂载带 nodev：打开这个 /dev/null 会 EACCES，读写都失败（与 seatbelt 一致）
    else args.push('--ro-bind', '/dev/null', p);
  }
  const home = canonicalPath(keelHome());
  if (fs.existsSync(home)) args.push('--tmpfs', home);
  if (!sandbox.network) args.push('--unshare-net');
  args.push('--chdir', ws);
  return args;
}

/** 把一条 shell 命令包进沙箱，返回 spawn 的 [可执行文件, 参数] */
export function sandboxedCommand(kind: SandboxKind, cfg: KeelConfig, cwd: string, command: string): [string, string[]] {
  if (kind === 'seatbelt') return ['/usr/bin/sandbox-exec', ['-p', seatbeltProfile(cfg, cwd), '/bin/bash', '-c', command]];
  return ['bwrap', [...bwrapArgs(cfg, cwd), '/bin/bash', '-c', command]];
}
