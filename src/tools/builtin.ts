import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { ToolCtx, ToolDef, ToolOutput } from './types.js';
import { KeelConfig } from '../config.js';
import { FileChange } from '../events/types.js';
import { canonicalPath, checkPolicy } from '../policy/policy.js';
import { detectSandbox, sandboxedCommand } from './sandbox.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.keel', '__pycache__', '.venv', 'venv', '.next']);
const MAX_OUTPUT = 10_000;

export function truncateOutput(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.4)) + `\n…[输出已截断，全长 ${s.length} 字符]…\n` + s.slice(-Math.floor(max * 0.55));
}

/** 子进程环境：移除 harness 自己的 provider 密钥（bash/verify/hooks 共用） */
export function childEnv(cfg: KeelConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const provider of Object.values(cfg.providers)) delete env[provider.apiKeyEnv];
  delete env.KEEL_API_KEY;
  return env;
}

/** 写入前快照原内容（检查点）：超过上限的文件只记录"未追踪"，rewind 会拒绝恢复它 */
const SNAPSHOT_LIMIT = 10_000_000;
function snapshot(ctx: ToolCtx, abs: string): Pick<FileChange, 'before' | 'untracked'> {
  const target = canonicalPath(abs);
  if (!fs.existsSync(target)) return { before: null };
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > SNAPSHOT_LIMIT) return { before: null, untracked: true };
  return { before: ctx.store.putBlob(fs.readFileSync(target)) };
}

export function resolveIn(ctx: ToolCtx, p: string): string {
  return path.resolve(ctx.cwd, p);
}

/** Check the opened descriptor; O_NONBLOCK also prevents a raced-in FIFO from hanging open. */
function readFile(abs: string): string {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('只支持普通文件');
    if (stat.size > 2_000_000) throw new Error(`文件过大 (${stat.size} 字节)，请用 bash 处理`);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

/** A failed/partial write must not truncate the user's existing file. */
function writeFile(abs: string, content: string): void {
  const target = canonicalPath(abs);
  const exists = fs.existsSync(target);
  if (exists && !fs.statSync(target).isFile()) throw new Error('只支持普通文件');
  const temporary = `${target}.keel-${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', exists ? fs.statSync(target).mode & 0o777 : 0o666);
  try {
    try { fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function relIn(ctx: ToolCtx, abs: string): string {
  const rel = path.relative(ctx.cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

function err(msg: string): ToolOutput {
  return { ok: false, output: msg };
}

/** Returning false from the visitor stops the whole walk once the result limit is reached. */
async function walk(root: string, cb: (abs: string) => boolean | void | Promise<boolean | void>, depth = 0, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (depth > 12) return true;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const d of entries) {
    signal?.throwIfAborted();
    const abs = path.join(root, d.name);
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name) || d.isSymbolicLink()) continue;
      if (!await walk(abs, cb, depth + 1, signal)) return false;
    } else if (d.isFile()) {
      if (await cb(abs) === false) return false;
    }
  }
  return true;
}

export const readTool: ToolDef = {
  name: 'read',
  description: '读取文件内容（带行号）。支持 offset/limit 分段读大文件。受 denyPaths 策略约束。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对当前目录或绝对路径）' },
      offset: { type: 'integer', description: '起始行（1 起），默认 1' },
      limit: { type: 'integer', description: '读取行数，默认 2000' },
    },
    required: ['path'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const abs = resolveIn(ctx, String(input.path));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return err(`文件不存在: ${relIn(ctx, abs)}`);
    }
    if (stat.isDirectory()) {
      const items = fs.readdirSync(abs).slice(0, 200);
      return { ok: true, output: `目录 ${relIn(ctx, abs)} 包含:\n${items.join('\n')}` };
    }
    const raw = readFile(abs);
    const lines = raw.split('\n');
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.min(2000, Math.max(1, Number(input.limit) || 2000));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${offset + i}| ${l.slice(0, 2000)}`).join('\n');
    const more = lines.length > offset - 1 + limit ? `\n…[共 ${lines.length} 行，已截断]` : '';
    return { ok: true, output: truncateOutput(body + more) };
  },
};

export const writeTool: ToolDef = {
  name: 'write',
  description: '写入（创建或覆盖）文件。会自动创建父目录。修改文件前应先 read。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const abs = resolveIn(ctx, String(input.path));
    const content = String(input.content ?? '');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    const before = snapshot(ctx, abs);
    writeFile(abs, content);
    const n = content ? content.split('\n').length : 0;
    return {
      ok: true,
      output: `${existed ? '覆盖' : '创建'}了 ${relIn(ctx, abs)}（${n} 行，${Buffer.byteLength(content)} 字节）`,
      changes: [{ path: relIn(ctx, abs), ...before, after: ctx.store.putBlob(Buffer.from(content, 'utf8')) }],
    };
  },
};

export const editTool: ToolDef = {
  name: 'edit',
  description: '精确字符串替换编辑文件。oldText 必须在文件中唯一（除非 replaceAll=true）。修改前应先 read。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      oldText: { type: 'string', description: '要替换的原文（需唯一）' },
      newText: { type: 'string', description: '替换为' },
      replaceAll: { type: 'boolean', description: '替换全部匹配，默认 false' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const abs = resolveIn(ctx, String(input.path));
    let raw: string;
    try {
      raw = readFile(abs);
    } catch (e) {
      return err(`无法编辑 ${relIn(ctx, abs)}: ${(e as Error).message}`);
    }
    const oldText = String(input.oldText ?? '');
    const newText = String(input.newText ?? '');
    if (!oldText) return err('oldText 不能为空');
    const count = raw.split(oldText).length - 1;
    if (count === 0) return err(`oldText 在 ${relIn(ctx, abs)} 中未找到`);
    if (count > 1 && !input.replaceAll) {
      return err(`oldText 匹配了 ${count} 处，需先扩大上下文使其唯一，或设置 replaceAll=true`);
    }
    const replaced = input.replaceAll ? raw.replaceAll(oldText, () => newText) : raw.replace(oldText, () => newText);
    const before = snapshot(ctx, abs);
    writeFile(abs, replaced);
    const n = input.replaceAll ? count : 1;
    return {
      ok: true,
      output: `编辑了 ${relIn(ctx, abs)}（${n} 处替换，${raw.split('\n').length} → ${replaced.split('\n').length} 行）`,
      changes: [{ path: relIn(ctx, abs), ...before, after: ctx.store.putBlob(Buffer.from(replaced, 'utf8')) }],
    };
  },
};

export const bashTool: ToolDef = {
  name: 'bash',
  description: '在当前目录执行前台 bash 命令（stdout/stderr 合并返回）。命令结束后清理同组后台进程，不保留常驻服务。受 bashDeny/bashApprove 策略约束；开启沙箱时只能写工作目录与临时目录，且可能无外网。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认 120000，上限 600000' },
    },
    required: ['command'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    if (ctx.signal?.aborted) return { ok: false, output: '操作已中断', exitCode: -1 };
    const command = String(input.command ?? '');
    const timeoutMs = Math.min(600_000, Math.max(1000, Number(input.timeoutMs) || 120_000));
    return new Promise((resolve) => {
      // detached 建独立进程组：超时/中断时整组杀死，避免孙进程泄漏
      const env = childEnv(ctx.cfg);
      let file = '/bin/bash';
      let args = ['-c', command];
      if (ctx.cfg.sandbox.mode !== 'off') {
        const kind = detectSandbox();
        // 要求沙箱但本机没有：拒绝执行，而不是悄悄裸跑
        if (!kind) return resolve({ ok: false, output: `sandbox.mode=${ctx.cfg.sandbox.mode}，但本机没有可用的 OS 沙箱（macOS sandbox-exec / Linux bwrap），已拒绝执行`, exitCode: -1 });
        try { [file, args] = sandboxedCommand(kind, ctx.cfg, ctx.cwd, command); }
        catch (e) { return resolve({ ok: false, output: (e as Error).message, exitCode: -1 }); }
      }
      const child = spawn(file, args, { cwd: ctx.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let capped = false;
      const collect = (chunk: Buffer) => {
        if (out.length >= 200_000) {
          capped = true;
          return;
        }
        out += chunk.toString();
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(killTree, timeoutMs);
      // Foreground-only: reap descendants even if they redirected or retained the shell's pipes.
      child.once('exit', killTree);
      const onAbort = () => killTree();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal?.aborted) onAbort();
      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
      };
      child.on('close', (code, signal) => {
        cleanup();
        if (capped) out += '\n…[输出超上限 200k 字符，已截断]…';
        const tail = truncateOutput(out);
        const status = signal ? `信号 ${signal} 终止${signal === 'SIGKILL' ? '（超时或被中断）' : ''}` : `exit ${code}`;
        resolve({
          ok: code === 0 && !signal && !(ctx.signal?.aborted ?? false),
          output: tail ? `${tail}\n[${status}]` : `[${status}]`,
          exitCode: signal ? -1 : (code ?? -1),
        });
      });
      child.on('error', (e) => {
        cleanup();
        resolve(err(`无法启动进程: ${e.message}`));
      });
    });
  },
};

export const globTool: ToolDef = {
  name: 'glob',
  description: '按 glob 模式（支持 **、*、?）查找文件，返回相对路径列表。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: "如 'src/**/*.ts'、'*.json'、'**/*.md'" },
      path: { type: 'string', description: '起始目录，默认当前目录' },
    },
    required: ['pattern'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const { globToRegExp } = await import('../util/glob.js');
    const re = globToRegExp(String(input.pattern));
    const root = resolveIn(ctx, String(input.path ?? '.'));
    const hits: string[] = [];
    await walk(root, (abs) => {
      if (checkPolicy(ctx.cfg.policy, { tool: 'read', input: { path: abs }, cwd: ctx.cwd }).decision !== 'allow') return;
      const rel = relIn(ctx, abs);
      if (re.test(rel)) hits.push(rel);
      return hits.length < 500;
    }, 0, ctx.signal);
    return {
      ok: true,
      output: hits.length ? hits.join('\n') + (hits.length >= 500 ? '\n…[已截断到 500 条]' : '') : '无匹配文件',
    };
  },
};

export const grepTool: ToolDef = {
  name: 'grep',
  description: '在目录内递归按正则搜索文本，返回 file:line: content。搜索限时 5 秒，可缩小 path/glob 范围。默认忽略 .git/node_modules 等。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索目录，默认当前目录' },
      glob: { type: 'string', description: '只搜匹配该 glob 的文件名，如 *.ts' },
      ignoreCase: { type: 'boolean', description: '忽略大小写，默认 true' },
    },
    required: ['pattern'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const fileRe = input.glob ? (await import('../util/glob.js')).globToRegExp(String(input.glob)) : null;
    const root = resolveIn(ctx, String(input.path ?? '.'));
    const hits: string[] = [];
    // One short-lived worker per search keeps backtracking off the agent's event loop.
    // The script is constant; model input is transferred as data, never evaluated as code.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const re = new RegExp(workerData.pattern, workerData.ignoreCase === false ? '' : 'i');
      parentPort.postMessage('ready');
      parentPort.on('message', ({ text, limit }) => {
        const hits = [];
        const lines = text.split('\\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i])) hits.push([i + 1, lines[i].slice(0, 240)]);
        }
        parentPort.postMessage(hits);
      });
    `, { eval: true, execArgv: [], workerData: { pattern: input.pattern, ignoreCase: input.ignoreCase } });
    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error('搜索已中断'));
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('搜索超时（5 秒），请缩小范围或简化正则')), 5000);
    worker.on('error', (error) => controller.abort(error));
    try {
      await once(worker, 'message', { signal: controller.signal });
      await walk(root, async (abs) => {
        if (checkPolicy(ctx.cfg.policy, { tool: 'read', input: { path: abs }, cwd: ctx.cwd }).decision !== 'allow') return;
        if (fileRe && !fileRe.test(path.basename(abs))) return;
        let text: string;
        try {
          text = readFile(abs);
        } catch {
          return;
        }
        if (text.slice(0, 8000).includes('\0')) return; // 二进制文件
        const result = once(worker, 'message', { signal: controller.signal });
        worker.postMessage({ text, limit: 200 - hits.length });
        const [matches] = await result as [Array<[number, string]>];
        for (const [line, content] of matches) hits.push(`${relIn(ctx, abs)}:${line}: ${content}`);
        return hits.length < 200;
      }, 0, controller.signal);
      controller.signal.throwIfAborted();
      return {
        ok: true,
        output: hits.length ? hits.join('\n') + (hits.length >= 200 ? '\n…[已截断到 200 条]' : '') : '无匹配',
      };
    } catch (e) {
      return err(`搜索失败: ${((controller.signal.reason ?? e) as Error).message}`);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      await worker.terminate();
    }
  },
};
