import { PolicyCfg } from '../config.js';
import { anyGlobMatch } from '../util/glob.js';
import path from 'node:path';
import fs from 'node:fs';

export interface PolicyVerdict {
  decision: 'allow' | 'deny' | 'approve';
  /** 命中的规则说明，deny/approve 时给出 */
  rule: string | null;
}

const PATH_TOOLS = new Set(['read', 'write', 'edit']);
const DIR_TOOLS = new Set(['glob', 'grep']);
const WRITE_TOOLS = new Set(['write', 'edit']);

function outsideWorkspace(abs: string, cwd: string): boolean {
  const rel = path.relative(cwd, abs);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** Resolve links even when a write targets a not-yet-created file. */
export function canonicalPath(abs: string, depth = 0): string {
  if (depth > 40) throw new Error('符号链接循环');
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      return canonicalPath(path.resolve(path.dirname(abs), fs.readlinkSync(abs)), depth + 1);
    }
    return fs.realpathSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonicalPath(parent, depth + 1), path.basename(abs));
  }
}

export function verificationCommands(input: Record<string, unknown>, defaults: string[]): string[] {
  const extra = Array.isArray(input.commands) ? input.commands as string[] : [];
  // Run mandatory checks last, so extra commands cannot change files after they pass.
  return [...new Set([...extra.filter((command) => !defaults.includes(command)), ...defaults])];
}

/**
 * 声明式策略引擎：所有工具调用先过这里再执行，判定本身也作为 policy.decision 事件落盘（审计）。
 * denyPaths 同时约束读写——.env、私钥这类文件既不许改也不许读出去。
 * constrainToWorkspace（默认开）禁止路径类工具越出工作目录；bash 不受此约束（见 README 安全边界）。
 */
export function checkPolicy(
  policy: PolicyCfg,
  req: { tool: string; input: Record<string, unknown>; cwd: string; verifyCommands?: string[] },
): PolicyVerdict {
  if (policy.readOnly && ['write', 'edit', 'bash', 'verify'].includes(req.tool)) {
    return { decision: 'deny', rule: 'policy.readOnly=true' };
  }

  if (PATH_TOOLS.has(req.tool) || DIR_TOOLS.has(req.tool)) {
    const abs = path.resolve(req.cwd, typeof req.input.path === 'string' ? req.input.path : '.');
    let real: string;
    let workspace: string;
    try {
      real = canonicalPath(abs);
      workspace = canonicalPath(path.resolve(req.cwd));
    } catch (e) {
      return { decision: 'deny', rule: `路径无法安全解析: ${(e as Error).message}` };
    }
    if (policy.constrainToWorkspace) {
      if (outsideWorkspace(abs, path.resolve(req.cwd)) || outsideWorkspace(real, workspace)) {
        return { decision: 'deny', rule: 'constrainToWorkspace: 路径在工作目录之外（如需放开设 policy.constrainToWorkspace=false）' };
      }
    }
    const targets = [abs, real];
    // A matched directory also covers its descendants.
    for (const target of [...targets]) {
      for (let p = path.dirname(target); p !== path.dirname(p); p = path.dirname(p)) targets.push(p);
    }
    const find = (globs: string[]) => globs.find((g) => targets.some((p) =>
      anyGlobMatch([g], p) || anyGlobMatch([g], path.relative(req.cwd, p)) || anyGlobMatch([g], path.relative(workspace, p))));
    const hit = find(policy.denyPaths);
    if (hit) return { decision: 'deny', rule: `denyPaths: ${hit}` };
    if (WRITE_TOOLS.has(req.tool)) {
      const protectedHit = find(policy.protectPaths);
      if (protectedHit) return { decision: 'deny', rule: `protectPaths: ${protectedHit}（只读保护）` };
      if (policy.writePaths.length && !find(policy.writePaths)) {
        return { decision: 'deny', rule: `writePaths: 不在允许写入的范围（${policy.writePaths.join(', ')}）` };
      }
      const approveHit = find(policy.approvePaths);
      if (approveHit) return { decision: 'approve', rule: `approvePaths: ${approveHit}` };
    }
  }

  if (req.tool === 'verify') {
    const verdicts = verificationCommands(req.input, req.verifyCommands ?? []).map((command) =>
      checkPolicy(policy, { tool: 'bash', input: { command }, cwd: req.cwd }));
    return verdicts.find((v) => v.decision === 'deny') ?? verdicts.find((v) => v.decision === 'approve') ?? { decision: 'allow', rule: null };
  }

  if (req.tool === 'bash' && typeof req.input.command === 'string') {
    const cmd = req.input.command;
    const denyHit = policy.bashDeny.find((g) => anyGlobMatch([g], cmd));
    if (denyHit) return { decision: 'deny', rule: `bashDeny: ${denyHit}` };
    const approveHit = policy.bashApprove.find((g) => anyGlobMatch([g], cmd));
    if (approveHit) return { decision: 'approve', rule: `bashApprove: ${approveHit}` };
  }

  return { decision: 'allow', rule: null };
}
