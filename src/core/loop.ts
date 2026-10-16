import { execSync } from 'node:child_process';
import { KeelConfig } from '../config.js';
import { StopReason } from '../events/types.js';
import { Router } from '../llm/router.js';
import { ChatMessage } from '../llm/types.js';
import { fold } from './fold.js';
import { SessionStore } from './store.js';
import { estimateTokens } from './tokens.js';
import { TOOL_NAMES, TOOL_SCHEMAS, executeToolCall, parseToolInput, ToolCtx } from '../tools/index.js';
import { checkPolicy } from '../policy/policy.js';
import { applyPreToolHooks } from '../policy/hooks.js';
import { sandboxFor } from '../tools/sandbox.js';
import { Ui } from '../ui/render.js';

const MAX_PUSHBACKS = 2;

export interface TurnOptions {
  store: SessionStore;
  cfg: KeelConfig;
  ui: Ui;
  interactive: boolean;
  userText: string;
  /** 非交互模式下 approve 判定是否自动放行（--yes） */
  autoApprove: boolean;
  maxTurns?: number;
  /** 用户中断信号：传导到 LLM fetch 与 bash 子进程，并在事件流落 aborted */
  signal?: AbortSignal;
}

export interface TurnSummary {
  stopReason: StopReason;
  evidenceOk: boolean | null;
  spendUsd: number;
}

export function getGitBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(cfg: KeelConfig, cwd: string): string {
  const branch = getGitBranch(cwd);
  return [
    '你是 Keel（龙骨），一个在用户本地仓库工作的编码智能体。当前时间见会话事件。',
    `工作目录: ${cwd}${branch ? `（git 分支: ${branch}）` : '（非 git 仓库）'}`,
    '',
    '可用工具: ' + TOOL_NAMES.join(', ') + '。',
    '工作准则:',
    '- 只在当前工作目录内读写文件（策略默认强制，越界会被拒绝）。',
    '- 修改文件前先 read 确认现状；编辑优先用 edit 精确替换，避免无意义地整文件重写。',
    '- 不了解仓库结构时先用 glob/grep 探索，再动手。',
    '- 任务包含多个步骤时，先用 plan 工具列出计划，之后每完成一步就更新状态——计划随事件流落盘，用户可以审计你的进度。',
    '- bash 只做必要操作，避免破坏性命令。',
    ...(cfg.policy.protectPaths.length ? [`- 只读保护（可读不可改）: ${cfg.policy.protectPaths.join(', ')}。`] : []),
    ...(cfg.policy.writePaths.length ? [`- 只允许修改: ${cfg.policy.writePaths.join(', ')}；其它路径的写入会被拒绝。`] : []),
    ...(cfg.sandbox.mode !== 'off' ? [`- bash/verify 运行在 OS 沙箱：只能写工作目录与临时目录${cfg.sandbox.network ? '' : '，没有外网（本机 localhost 可用）'}。`] : []),
    '- 用简体中文简要说明你正在做什么和为什么。',
    '',
    '【完成契约 —— 由 harness 强制执行】',
    '只要调用过 write/edit/bash（包括失败或中断），在结束任务前必须调用 verify 工具运行验证。',
    '项目 .keel.json 的 verify.commands 是必跑检查，commands 仅能追加，必须全部通过。',
    'harness 会拦截缺少验证证据的完成声明并打回。',
    '分叉或新一轮用户输入会使旧验证证据失效：工作目录可能已被外部修改，必须重新 verify。',
  ].join('\n');
}

function messagesToText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const head = `[${m.role}]`;
      if (m.tool_calls?.length) {
        const calls = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join('; ');
        return `${head} ${m.content ?? ''}\n  工具调用: ${calls}`;
      }
      return `${head} ${m.content ?? ''}`;
    })
    .join('\n\n');
}

/** 上下文压缩：用 fast 模型把旧消息折叠成摘要。事件流里全量历史永远在，fork 回去即可还原。 */
async function maybeCompact(store: SessionStore, cfg: KeelConfig, ui: Ui, router: Router, budgetExceeded: () => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  const st = fold(store.readAll());
  if (estimateTokens(st.messages) <= cfg.context.compactThresholdTokens) return true;

  let keep = cfg.context.keepRecentMessages;
  while (keep < st.messages.length && st.messages[st.messages.length - keep]?.role === 'tool') {
    keep++; // 不拆散 assistant(tool_calls) 与其 tool 结果
  }
  if (st.messages.length <= keep + 2) return true;

  const kept = st.messages.slice(st.messages.length - keep);
  const toSummarize = st.messages.slice(0, st.messages.length - keep);
  const text = messagesToText(toSummarize);
  const summaries: string[] = [];
  ui.note('上下文过长，用 fast 模型压缩历史…');
  for (let offset = 0; offset < text.length; offset += 60_000) {
    if (await budgetExceeded()) return false;
    await store.append('llm.request', { role: 'fast', model: router.modelRef('fast'), tools: [], messageCount: 2 });
    const res = await router.chat('fast', [
      {
        role: 'system',
        content:
          '你是对话摘要器。把 agent 会话历史压缩成要点，必须保留：任务目标、已修改的文件路径与改动内容、关键决策、当前状态与未完成事项、验证状态。',
      },
      { role: 'user', content: text.slice(offset, offset + 60_000) },
    ], undefined, { signal, onRetry: (attempt, error, delayMs) => {
      store.append('llm.retry', { attempt, error: error.message, delayMs });
    } });
    await store.append('llm.response', {
      role: 'fast',
      model: res.model,
      content: res.message.content,
      toolCalls: [],
      usage: res.usage,
      costUsd: res.costUsd,
      costKnown: res.costKnown,
      usageEstimated: res.usageEstimated ?? false,
      latencyMs: res.latencyMs,
      inHistory: false,
    });
    summaries.push(res.message.content ?? '(空摘要)');
  }
  // Commit a new view only after every chunk succeeds; errors/budget stops keep the old view.
  await store.append('context.compacted', {
    upToSeq: store.seq,
    summary: summaries.join('\n\n'),
    keptMessages: kept,
  });
  return true;
}

/**
 * 处理一条用户输入：完整的多轮工具循环。
 * 每一步（请求、响应、策略判定、工具结果、压缩）都作为事件落盘——这是 Keel 的一切能力的来源。
 */
export async function runUserTurn(opts: TurnOptions): Promise<TurnSummary> {
  const release = opts.store.lock();
  try {
    return await runLockedTurn(opts);
  } catch (e) {
    opts.ui.spinStop();
    const stopReason = opts.signal?.aborted ? 'aborted' : 'error';
    opts.store.append('error', { where: 'turn', message: (e as Error).message });
    const state = fold(opts.store.readAll());
    const evidenceOk = state.lastFileModSeq > state.lastVerifyOkSeq ? false : state.lastVerifyOkSeq ? true : null;
    opts.store.append('turn.completed', { stopReason, evidenceOk, turns: 0, spendUsd: state.spend.totalUsd });
    opts.ui.error((e as Error).message);
    return { stopReason, evidenceOk, spendUsd: state.spend.totalUsd };
  } finally {
    release();
  }
}

async function runLockedTurn(opts: TurnOptions): Promise<TurnSummary> {
  const { store, cfg, ui } = opts;
  const ctx: ToolCtx = { cwd: store.meta.cwd, cfg, store, interactive: opts.interactive, signal: opts.signal };
  const router = new Router(cfg);
  const aborted = () => opts.signal?.aborted ?? false;

  // A crash/fork can leave an assistant tool batch unfinished. Never replay side effects.
  const state = fold(store.readAll());
  // ponytail: invalidate between turns; workspace fingerprints only if rechecking is too costly.
  if (state.lastVerifyOkSeq) store.append('verify.invalidated', { reason: '新一轮任务开始，工作目录或验证配置可能变化，需重新验证。' });
  const history = state.messages;
  const pending = new Map<string, NonNullable<ChatMessage['tool_calls']>[number]>();
  for (const message of history) {
    for (const call of message.tool_calls ?? []) pending.set(call.id, call);
    if (message.role === 'tool' && message.tool_call_id) pending.delete(message.tool_call_id);
  }
  for (const call of pending.values()) {
    store.append('tool.result', { toolCallId: call.id, tool: call.function.name, ok: false,
      output: '上次执行中断或在此事件处分叉，结果未知；未自动重放。请检查工作目录后继续。', durationMs: 0 });
  }
  await store.append('user.message', { text: opts.userText });
  store.setTitle(opts.userText.slice(0, 60));

  const sys: ChatMessage = { role: 'system', content: buildSystemPrompt(cfg, ctx.cwd) };
  const maxIters = opts.maxTurns ?? cfg.maxTurns;
  let pushbacks = 0;
  let stop: StopReason = 'done';
  let evidenceOk: boolean | null = null;
  let iter = 0;
  const budgetExceeded = async (): Promise<boolean> => {
    const spend = fold(store.readAll()).spend;
    const spentTokens = spend.inputTokens + spend.outputTokens;
    const capTokens = cfg.budget.maxTokensPerSession ?? 0;
    const usdExceeded = cfg.budget.maxUsdPerSession > 0 && spend.totalUsd >= cfg.budget.maxUsdPerSession;
    const tokensExceeded = capTokens > 0 && spentTokens >= capTokens;
    if (!usdExceeded && !tokensExceeded) return false;
    await store.append('budget.exceeded', { spentUsd: spend.totalUsd, capUsd: cfg.budget.maxUsdPerSession, spentTokens, capTokens });
    ui.warn(`预算熔断：累计 $${spend.totalUsd.toFixed(4)} / ${cfg.budget.maxUsdPerSession}；tokens ${spentTokens} / ${capTokens}`);
    return true;
  };

  for (iter = 1; iter <= maxIters; iter++) {
    if (aborted()) {
      stop = 'aborted';
      break;
    }

    if (await budgetExceeded()) { stop = 'budget'; break; }
    if (!await maybeCompact(store, cfg, ui, router, budgetExceeded, opts.signal)) { stop = 'budget'; break; }
    if (aborted()) { stop = 'aborted'; break; }
    if (await budgetExceeded()) { stop = 'budget'; break; }
    const st = fold(store.readAll());
    const messages: ChatMessage[] = [sys, ...st.messages];

    await store.append('llm.request', {
      role: 'main',
      model: router.modelRef('main'),
      tools: TOOL_NAMES,
      messageCount: messages.length,
    });

    ui.spinStart(`思考中 · ${router.modelRef('main')}`);
    let res;
    try {
      res = await router.chat('main', messages, TOOL_SCHEMAS, {
        onDelta: (s) => {
          ui.spinStop();
          ui.assistantDelta(s);
        },
        signal: opts.signal,
        onRetry: (failedAttempt, error, delayMs) => {
          store.append('llm.retry', { attempt: failedAttempt, error: error.message, delayMs });
          ui.note(`LLM 第 ${failedAttempt} 次调用失败（${error.message.slice(0, 140)}），${(delayMs / 1000).toFixed(1)}s 后重试`);
        },
      });
    } catch (e) {
      ui.spinStop();
      if (aborted()) {
        stop = 'aborted';
        break;
      }
      const msg = (e as Error).message ?? String(e);
      await store.append('error', { where: 'llm', message: msg });
      ui.error(`LLM 调用失败: ${msg}`);
      stop = 'error';
      break;
    }
    ui.spinStop();

    await store.append('llm.response', {
      role: 'main',
      model: res.model,
      content: res.message.content,
      toolCalls: res.message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })),
      usage: res.usage,
      costUsd: res.costUsd,
      costKnown: res.costKnown,
      latencyMs: res.latencyMs,
      inHistory: true,
      usageEstimated: res.usageEstimated ?? false,
    });
    if (!res.costKnown && fold(store.readAll()).spend.unpricedCalls === 1) ui.warn('模型价目未知，美元预算无法覆盖该调用；仍执行 token 上限，可在 pricing 配置费率。');
    if (res.message.content?.trim()) ui.assistantText(res.message.content);

    if (await budgetExceeded()) {
      stop = 'budget';
      break;
    }

    const calls = res.message.tool_calls;
    if (!calls.length) {
      const state = fold(store.readAll());
      const unverified = state.lastFileModSeq > state.lastVerifyOkSeq;
      if (unverified && pushbacks < MAX_PUSHBACKS) {
        pushbacks += 1;
        await store.append('system.note', {
          text: '完成契约：当前工作目录缺少有效验证证据（文件修改、分叉或新一轮输入会使旧证据失效）。请调用 verify 工具运行验证并确保通过，之后才能声明任务完成。',
          toModel: true,
        });
        ui.warn('harness 拦截：缺少验证证据的完成声明，已打回');
        continue;
      }
      stop = unverified ? 'unverified' : 'done';
      break;
    }

    for (const call of calls) {
      if (aborted()) {
        stop = 'aborted';
        break;
      }
      let input: Record<string, unknown> = {};
      try {
        input = parseToolInput(call);
      } catch (e) {
        await store.append('tool.result', { toolCallId: call.id, tool: call.function.name, ok: false,
          output: `工具参数错误: ${(e as Error).message}`, durationMs: 0 });
        continue;
      }

      const builtin = checkPolicy(cfg.policy, { tool: call.function.name, input, cwd: ctx.cwd, verifyCommands: cfg.verify.commands });
      const { verdict, hooks } = await applyPreToolHooks(cfg, { session: store.id, cwd: ctx.cwd, tool: call.function.name, input, policy: builtin }, opts.signal);
      await store.append('policy.decision', {
        tool: call.function.name,
        input,
        decision: verdict.decision,
        rule: verdict.rule,
        ...(hooks.length ? { hooks } : {}),
      });
      if (verdict.decision === 'deny') {
        ui.policyDenied(call.function.name, verdict.rule);
        await store.append('tool.result', {
          toolCallId: call.id,
          tool: call.function.name,
          ok: false,
          output: `被策略拒绝：${verdict.rule}`,
          durationMs: 0,
        });
        continue;
      }
      if (verdict.decision === 'approve') {
        const allowed = opts.autoApprove || (opts.interactive && await ui.approve(`允许执行 ${call.function.name} ${JSON.stringify(input)}？（命中规则: ${verdict.rule}）`, opts.signal));
        if (!allowed) {
          await store.append('tool.result', {
            toolCallId: call.id,
            tool: call.function.name,
            ok: false,
            output: '用户拒绝执行该操作。',
            durationMs: 0,
          });
          ui.warn('已拒绝');
          continue;
        }
      }

      if (aborted()) { stop = 'aborted'; break; }
      ui.toolStart(call.function.name, input);
      const shell = call.function.name === 'bash' || call.function.name === 'verify';
      await store.append('tool.call', {
        toolCallId: call.id,
        tool: call.function.name,
        input,
        ...(shell ? { sandbox: cfg.sandbox.mode === 'off' ? null : sandboxFor(cfg) ?? 'unavailable' } : {}),
      });
      const t0 = Date.now();
      const out = await executeToolCall(call, { ...ctx, approved: true });
      const durationMs = Date.now() - t0;
      if (out.changes?.length) await store.append('file.changed', { toolCallId: call.id, tool: call.function.name, changes: out.changes });
      await store.append('tool.result', {
        toolCallId: call.id,
        tool: call.function.name,
        ok: out.ok,
        output: out.output,
        durationMs,
      });
      ui.toolResult(out.ok, out.output, durationMs);
    }
    if (stop === 'aborted') break;
  }

  if (aborted()) stop = 'aborted';
  else if (iter > maxIters) stop = 'max-turns';
  const finalState = fold(store.readAll());
  const finalSpend = finalState.spend;
  evidenceOk = finalState.lastFileModSeq > finalState.lastVerifyOkSeq ? false : finalState.lastVerifyOkSeq ? true : null;
  await store.append('turn.completed', {
    stopReason: stop,
    evidenceOk,
    turns: Math.min(iter, maxIters),
    spendUsd: finalSpend.totalUsd,
  });
  return { stopReason: stop, evidenceOk, spendUsd: finalSpend.totalUsd };
}
