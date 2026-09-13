/**
 * 事件类型定义 —— Keel 的核心。
 * 会话不是"一段对话"，而是一条 append-only 的事件流；
 * 任何状态（消息历史、花费、验证状态、文件改动）都是对这条流的 fold。
 */

export type EventName =
  | 'session.started'
  | 'user.message'
  | 'system.note'
  | 'llm.request'
  | 'llm.response'
  | 'tool.call'
  | 'tool.result'
  | 'policy.decision'
  | 'verify.started'
  | 'verify.result'
  | 'context.compacted'
  | 'turn.completed'
  | 'budget.exceeded'
  | 'error';

export interface Event<T = Record<string, unknown>> {
  /** 会话内单调递增序号，从 1 开始 */
  seq: number;
  id: string;
  ts: string;
  /** 所属会话 id */
  session: string;
  /** fork 来源会话 id；原生会话为 null */
  parent: string | null;
  /** fork 时复制到的父会话 seq */
  forkedAtSeq: number | null;
  type: EventName;
  data: T;
}

export interface SessionStartedData {
  cwd: string;
  gitBranch: string | null;
  model: string;
  interactive: boolean;
}

export interface UserMessageData {
  text: string;
}

export interface SystemNoteData {
  text: string;
  /** note 会注入给模型（影响后续请求）还是仅给人看 */
  toModel: boolean;
}

export interface LlmRequestData {
  role: 'main' | 'fast';
  model: string;
  tools: string[];
  messageCount: number;
}

export interface ToolCallPayload {
  id: string;
  name: string;
  arguments: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponseData {
  role: 'main' | 'fast';
  model: string;
  content: string | null;
  toolCalls: ToolCallPayload[];
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  /** 压缩摘要等辅助调用不进入对话历史 */
  inHistory: boolean;
}

export interface PolicyDecisionData {
  tool: string;
  input: Record<string, unknown>;
  decision: 'allow' | 'deny' | 'approve';
  rule: string | null;
}

export interface ToolCallData {
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultData {
  toolCallId: string;
  tool: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface VerifyStartedData {
  commands: string[];
}

export interface VerifyCommandResult {
  command: string;
  code: number;
  durationMs: number;
  outputExcerpt: string;
}

export interface VerifyResultData {
  ok: boolean;
  results: VerifyCommandResult[];
}

export interface ContextCompactedData {
  /** 摘要覆盖到的事件 seq（含） */
  upToSeq: number;
  summary: string;
  /** 压缩时保留的近期消息（随事件落盘，fold 时跟在摘要后） */
  keptMessages: { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
}

export type StopReason = 'done' | 'max-turns' | 'budget' | 'aborted' | 'error' | 'unverified';

export interface TurnCompletedData {
  stopReason: StopReason;
  evidenceOk: boolean | null;
  turns: number;
  spendUsd: number;
}

export interface BudgetExceededData {
  spentUsd: number;
  capUsd: number;
}

export interface ErrorData {
  where: string;
  message: string;
}
