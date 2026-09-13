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
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  message: { content: string | null; tool_calls: ToolCall[] };
  usage: ChatUsage;
}

export interface LlmProvider {
  chat(params: ChatParams): Promise<ChatResult>;
}
