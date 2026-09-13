import { execSync } from 'node:child_process';
import { KeelConfig } from '../config.js';
import { StopReason } from '../events/types.js';
import { Router } from '../llm/router.js';
import { ChatMessage } from '../llm/types.js';
import { fold } from './fold.js';
import { SessionStore } from './store.js';
import { estimateTokens } from './tokens.js';
import { TOOL_NAMES, TOOL_SCHEMAS, executeToolCall, ToolCtx } from '../tools/index.js';
import { checkPolicy } from '../policy/policy.js';
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
  isAborted?: () => boolean;
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
    '- 修改文件前先 read 确认现状；编辑优先用 edit 精确替换，避免无意义地整文件重写。',
    '- 不了解仓库结构时先用 glob/grep 探索，再动手。',
    '- bash 只做必要操作，避免破坏性命令。',
    '- 用简体中文简要说明你正在做什么和为什么。',
    '',
    '【完成契约 —— 由 harness 强制执行】',
    '只要你对任何文件做过修改（write/edit），在结束任务前必须调用 verify 工具运行验证',
    '（不传 commands 时使用项目 .keel.json 的 verify.commands），并确保验证通过。',
    'harness 会拦截缺少验证证据的完成声明并打回。',
  ].join('\n');
}

function messagesToText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const head = `[${m.role}]`;
      if (m.tool_calls?.length) {
        const calls = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`).join('; ');
        return `${head} ${m.content ?? ''}\n  工具调用: ${calls}`;
      }
      return `${head} ${m.content ?? ''}`;
    })
    .join('\n\n');
}

/** 上下文压缩：用 fast 模型把旧消息折叠成摘要。事件流里全量历史永远在，fork 回去即可还原。 */
async function maybeCompact(store: SessionStore, cfg: KeelConfig, ui: Ui, router: Router): Promise<void> {
  const st = fold(store.readAll());
  if (estimateTokens(st.messages) <= cfg.context.compactThresholdTokens) return;

  let keep = cfg.context.keepRecentMessages;
  while (keep < st.messages.length && st.messages[st.messages.length - keep]?.role === 'tool') {
    keep++; // 不拆散 assistant(tool_calls) 与其 tool 结果
  }
  if (st.messages.length <= keep + 2) return;

  const kept = st.messages.slice(st.messages.length - keep);
  const toSummarize = st.messages.slice(0, st.messages.length - keep);
  ui.note('上下文过长，用 fast 模型压缩历史…');
  const res = await router.chat('fast', [
    {
      role: 'system',
      content:
        '你是对话摘要器。把 agent 会话历史压缩成要点，必须保留：任务目标、已修改的文件路径与改动内容、关键决策、当前状态与未完成事项、验证状态。',
    },
    { role: 'user', content: messagesToText(toSummarize).slice(0, 60_000) },
  ]);
  await store.append('llm.response', {
    role: 'fast',
    model: res.model,
    content: res.message.content,
    toolCalls: [],
    usage: res.usage,
    costUsd: res.costUsd,
    latencyMs: res.latencyMs,
    inHistory: false,
  });
  await store.append('context.compacted', {
    upToSeq: store.seq,
    summary: res.message.content ?? '(空摘要)',
    keptMessages: kept,
  });
}

/**
 * 处理一条用户输入：完整的多轮工具循环。
 * 每一步（请求、响应、策略判定、工具结果、压缩）都作为事件落盘——这是 Keel 的一切能力的来源。
 */
export async function runUserTurn(opts: TurnOptions): Promise<TurnSummary> {
  const { store, cfg, ui } = opts;
  const ctx: ToolCtx = { cwd: store.meta.cwd, cfg, store, interactive: opts.interactive };
  const router = new Router(cfg);

  const ev = await store.append('user.message', { text: opts.userText });
  store.setTitle(opts.userText.slice(0, 60));

  const sys: ChatMessage = { role: 'system', content: buildSystemPrompt(cfg, ctx.cwd) };
  const maxIters = opts.maxTurns ?? cfg.maxTurns;
  let pushbacks = 0;
  let stop: StopReason = 'done';
  let evidenceOk: boolean | null = null;
  let iter = 0;

  for (iter = 1; iter <= maxIters; iter++) {
    if (opts.isAborted?.()) {
      stop = 'aborted';
      break;
    }

    await maybeCompact(store, cfg, ui, router);
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
      res = await router.chat('main', messages, TOOL_SCHEMAS);
    } catch (e) {
      ui.spinStop();
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
      latencyMs: res.latencyMs,
      inHistory: true,
    });
    if (res.message.content?.trim()) ui.assistantText(res.message.content);

    const spend = fold(store.readAll()).spend;
    if (cfg.budget.maxUsdPerSession > 0 && spend.totalUsd >= cfg.budget.maxUsdPerSession) {
      await store.append('budget.exceeded', { spentUsd: spend.totalUsd, capUsd: cfg.budget.maxUsdPerSession });
      ui.warn(`预算熔断：本会话已花费 $${spend.totalUsd.toFixed(4)}，达到上限 $${cfg.budget.maxUsdPerSession}`);
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
          text: '完成契约：本会话存在尚未通过验证的文件修改。请调用 verify 工具运行验证并确保通过，之后才能声明任务完成。',
          toModel: true,
        });
        ui.warn('harness 拦截：缺少验证证据的完成声明，已打回');
        continue;
      }
      stop = unverified ? 'unverified' : 'done';
      evidenceOk = unverified ? false : null;
      break;
    }

    for (const call of calls) {
      if (opts.isAborted?.()) {
        stop = 'aborted';
        break;
      }
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments || '{}');
      } catch {
        /* 保持空对象，工具自己报参数错误 */
      }

      const verdict = checkPolicy(cfg.policy, { tool: call.function.name, input, cwd: ctx.cwd });
      await store.append('policy.decision', {
        tool: call.function.name,
        input,
        decision: verdict.decision,
        rule: verdict.rule,
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
        const allowed = opts.autoApprove || (await ui.approve(`允许执行 ${call.function.name}？（命中规则: ${verdict.rule}）`));
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

      ui.toolStart(call.function.name, input);
      await store.append('tool.call', {
        toolCallId: call.id,
        tool: call.function.name,
        input,
      });
      const t0 = Date.now();
      const out = await executeToolCall(call, ctx);
      const durationMs = Date.now() - t0;
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

  if (iter > maxIters) stop = 'max-turns';
  const finalSpend = fold(store.readAll()).spend;
  await store.append('turn.completed', {
    stopReason: stop,
    evidenceOk,
    turns: iter,
    spendUsd: finalSpend.totalUsd,
  });
  return { stopReason: stop, evidenceOk, spendUsd: finalSpend.totalUsd };
}
