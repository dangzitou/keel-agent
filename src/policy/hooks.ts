import { spawn } from 'node:child_process';
import { HookCfg, KeelConfig } from '../config.js';
import { PolicyVerdict } from './policy.js';
import { childEnv } from '../tools/builtin.js';

export interface HookVerdict {
  command: string;
  decision: PolicyVerdict['decision'];
  reason: string;
  durationMs: number;
}

export interface PreToolRequest {
  session: string;
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
  /** 内置策略的判定，hook 可据此决定是否加码 */
  policy: PolicyVerdict;
}

const RANK = { allow: 0, approve: 1, deny: 2 } as const;

/** 跑一个 hook：stdin 收 JSON；exit 0 放行（stdout 可回 {"decision","reason"}），exit 2 拒绝，超时/崩溃/非法输出一律拒绝 */
function runHook(hook: HookCfg, cfg: KeelConfig, req: PreToolRequest, signal?: AbortSignal): Promise<HookVerdict> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const done = (decision: HookVerdict['decision'], reason: string) => resolve({ command: hook.command, decision, reason, durationMs: Date.now() - t0 });
    const child = spawn('/bin/bash', ['-c', hook.command], { cwd: req.cwd, env: childEnv(cfg), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { if (stdout.length < 65_536) stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 65_536) stderr += c.toString(); });
    let killedFor = '';
    const kill = (why: string) => {
      killedFor ||= why;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => kill(`超时（${hook.timeoutMs ?? 30_000}ms）`), hook.timeoutMs ?? 30_000);
    const onAbort = () => kill('已中断');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); done('deny', `hook 无法启动: ${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (killedFor) return done('deny', `hook ${killedFor}`);
      if (code === 2) return done('deny', stderr.trim().slice(0, 500) || 'hook 拒绝（exit 2）');
      if (code !== 0) return done('deny', `hook 失败（exit ${code}）${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
      const text = stdout.trim();
      if (!text) return done('allow', '');
      try {
        const out = JSON.parse(text) as { decision?: unknown; reason?: unknown };
        if (out.decision !== 'allow' && out.decision !== 'deny' && out.decision !== 'approve') throw new Error('decision 必须是 allow/deny/approve');
        done(out.decision, typeof out.reason === 'string' ? out.reason.slice(0, 500) : '');
      } catch (e) {
        done('deny', `hook 输出不合法: ${(e as Error).message}`);
      }
    });
    child.stdin.on('error', () => { /* hook 不读 stdin 时忽略 EPIPE */ });
    child.stdin.end(JSON.stringify({ event: 'preTool', ...req }));
  });
}

/**
 * 按顺序执行匹配的 preTool hooks，遇到 deny 即停。
 * hook 只能收紧内置策略（取最严判定），所以组织规则可以外挂，而不会意外放开 bashDeny/denyPaths。
 */
export async function applyPreToolHooks(cfg: KeelConfig, req: PreToolRequest, signal?: AbortSignal): Promise<{ verdict: PolicyVerdict; hooks: HookVerdict[] }> {
  const hooks: HookVerdict[] = [];
  let verdict = req.policy;
  if (verdict.decision === 'deny') return { verdict, hooks };
  for (const hook of cfg.hooks.preTool) {
    if (hook.tools && !hook.tools.includes(req.tool)) continue;
    const result = await runHook(hook, cfg, req, signal);
    hooks.push(result);
    if (RANK[result.decision] > RANK[verdict.decision]) {
      verdict = { decision: result.decision, rule: `hook ${hook.command}${result.reason ? `: ${result.reason}` : ''}` };
    }
    if (verdict.decision === 'deny') break;
  }
  return { verdict, hooks };
}
