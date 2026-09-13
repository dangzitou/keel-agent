import { PolicyCfg } from '../config.js';
import { anyGlobMatch } from '../util/glob.js';
import path from 'node:path';

export interface PolicyVerdict {
  decision: 'allow' | 'deny' | 'approve';
  /** 命中的规则说明，deny/approve 时给出 */
  rule: string | null;
}

const PATH_TOOLS = new Set(['read', 'write', 'edit']);
const DIR_TOOLS = new Set(['glob', 'grep']);

function outsideWorkspace(abs: string, cwd: string): boolean {
  const rel = path.relative(cwd, abs);
  return rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * 声明式策略引擎：所有工具调用先过这里再执行，判定本身也作为 policy.decision 事件落盘（审计）。
 * denyPaths 同时约束读写——.env、私钥这类文件既不许改也不许读出去。
 * constrainToWorkspace（默认开）禁止路径类工具越出工作目录；bash 不受此约束（见 README 安全边界）。
 */
export function checkPolicy(
  policy: PolicyCfg,
  req: { tool: string; input: Record<string, unknown>; cwd: string },
): PolicyVerdict {
  if (policy.readOnly && ['write', 'edit', 'bash'].includes(req.tool)) {
    return { decision: 'deny', rule: 'policy.readOnly=true' };
  }

  if (policy.constrainToWorkspace) {
    const target =
      (PATH_TOOLS.has(req.tool) && typeof req.input.path === 'string' && req.input.path) ||
      (DIR_TOOLS.has(req.tool) && typeof req.input.path === 'string' && req.input.path) ||
      null;
    if (target) {
      const abs = path.resolve(req.cwd, target);
      if (outsideWorkspace(abs, req.cwd)) {
        return { decision: 'deny', rule: 'constrainToWorkspace: 路径在工作目录之外（如需放开设 policy.constrainToWorkspace=false）' };
      }
    }
  }

  if (PATH_TOOLS.has(req.tool) && typeof req.input.path === 'string') {
    const abs = path.resolve(req.cwd, req.input.path);
    const rel = path.relative(req.cwd, abs) || abs;
    const hit = policy.denyPaths.find((g) => anyGlobMatch([g], rel) || anyGlobMatch([g], abs));
    if (hit) return { decision: 'deny', rule: `denyPaths: ${hit}` };
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
