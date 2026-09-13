export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  /** SSE 流式返回；onDelta 逐段回调文本增量 */
  stream?: boolean;
  onDelta?: (text: string) => void;
  /** 外部中断信号（用户 Ctrl+C） */
  signal?: AbortSignal;
  /** 单次请求超时毫秒 */
  timeoutMs?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  message: { content: string | null; tool_calls: ToolCall[] };
  usage: ChatUsage;
  /** usage 来自估算（流式响应未回传 usage 时） */
  usageEstimated?: boolean;
}

export interface LlmProvider {
  chat(params: ChatParams): Promise<ChatResult>;
}
