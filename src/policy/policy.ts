import { PolicyCfg } from '../config.js';
import { anyGlobMatch } from '../util/glob.js';
import path from 'node:path';

export interface PolicyVerdict {
  decision: 'allow' | 'deny' | 'approve';
  /** 命中的规则说明，deny/approve 时给出 */
  rule: string | null;
}

const PATH_TOOLS = new Set(['read', 'write', 'edit']);

/**
 * 声明式策略引擎：所有工具调用先过这里再执行，判定本身也作为 policy.decision 事件落盘（审计）。
 * denyPaths 同时约束读写——.env、私钥这类文件既不许改也不许读出去。
 */
export function checkPolicy(
  policy: PolicyCfg,
  req: { tool: string; input: Record<string, unknown>; cwd: string },
): PolicyVerdict {
  if (policy.readOnly && ['write', 'edit', 'bash'].includes(req.tool)) {
    return { decision: 'deny', rule: 'policy.readOnly=true' };
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
