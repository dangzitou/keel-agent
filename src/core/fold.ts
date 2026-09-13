import { Event } from '../events/types.js';
import { ChatMessage } from '../llm/types.js';

export interface ModelSpend {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface SpendState {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, ModelSpend>;
}

export interface FoldState {
  /** 从事件流重建的对话历史（已应用压缩摘要） */
  messages: ChatMessage[];
  spend: SpendState;
  turns: number;
  /** 最近一次成功落盘的文件修改（write/edit 的 tool.call seq） */
  lastFileModSeq: number;
  /** 最近一次验证通过（verify.result ok 的 seq） */
  lastVerifyOkSeq: number;
  lastUserSeq: number;
  compactUpToSeq: number;
  filesTouched: string[];
  title: string;
}

const FILE_MOD_TOOLS = new Set(['write', 'edit']);

export function emptySpend(): SpendState {
  return { totalUsd: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
}

/**
 * fold：状态 = fold(事件流)。这是 Keel 与"把对话存成数组"的传统 harness 的本质区别——
 * 消息、花费、验证状态全部从事件推导，fork/回放/审计都是同一份数据的视图。
 */
export function fold(events: Event[]): FoldState {
  const st: FoldState = {
    messages: [],
    spend: emptySpend(),
    turns: 0,
    lastFileModSeq: 0,
    lastVerifyOkSeq: 0,
    lastUserSeq: 0,
    compactUpToSeq: 0,
    filesTouched: [],
    title: '',
  };

  // 先收集 tool 结果，文件修改只在对应 tool.result ok 时计入
  const okResults = new Set<string>();
  for (const e of events as Event<any>[]) {
    if (e.type === 'tool.result' && e.data.ok) okResults.add(e.data.toolCallId);
  }

  for (const e of events as Event<any>[]) {
    switch (e.type) {
      case 'user.message': {
        const text = e.data.text as string;
        st.messages.push({ role: 'user', content: text });
        st.lastUserSeq = e.seq;
        if (!st.title) st.title = text.slice(0, 60);
        break;
      }
      case 'llm.response': {
        const d = e.data;
        const s = st.spend;
        s.totalUsd += d.costUsd;
        s.inputTokens += d.usage.inputTokens;
        s.outputTokens += d.usage.outputTokens;
        const m = (s.byModel[d.model] ??= { usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
        m.usd += d.costUsd;
        m.inputTokens += d.usage.inputTokens;
        m.outputTokens += d.usage.outputTokens;
        m.calls += 1;
        if (d.inHistory) {
          const toolCalls = d.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
          if (d.content || toolCalls.length > 0) {
            st.messages.push({
              role: 'assistant',
              content: d.content,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            });
          }
        }
        break;
      }
      case 'tool.result': {
        st.messages.push({ role: 'tool', content: e.data.output, tool_call_id: e.data.toolCallId });
        break;
      }
      case 'tool.call': {
        if (FILE_MOD_TOOLS.has(e.data.tool) && okResults.has(e.data.toolCallId)) {
          st.lastFileModSeq = Math.max(st.lastFileModSeq, e.seq);
          const p = e.data.input?.path;
          if (typeof p === 'string') st.filesTouched.push(p);
        }
        break;
      }
      case 'verify.result': {
        if (e.data.ok) st.lastVerifyOkSeq = e.seq;
        break;
      }
      case 'system.note': {
        if (e.data.toModel) st.messages.push({ role: 'user', content: `[harness] ${e.data.text}` });
        break;
      }
      case 'context.compacted': {
        // 压缩只是视图替换：事件流里永远有全量历史，fork 回压缩点即可恢复
        st.messages = [
          { role: 'user', content: `[历史摘要（覆盖事件 1–${e.data.upToSeq}）]\n${e.data.summary}` },
          ...(e.data.keptMessages as ChatMessage[]),
        ];
        st.compactUpToSeq = e.data.upToSeq;
        break;
      }
      case 'turn.completed': {
        st.turns += 1;
        break;
      }
    }
  }
  return st;
}
