import { ChatParams, ChatResult, LlmProvider, ToolCall } from './types.js';
import { estimateUsage, postJson, responseJson, sseDataChunks } from './http.js';

/** 内部消息（OpenAI 风格）→ OpenAI Responses 请求体 */
export function toResponsesBody(params: ChatParams, stream: boolean): Record<string, unknown> {
  let instructions: string | undefined;
  const input: Record<string, unknown>[] = [];
  for (const m of params.messages) {
    if (m.role === 'system') {
      instructions = [instructions, m.content].filter(Boolean).join('\n\n') || undefined;
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content ?? '' });
      continue;
    }
    // user/assistant 文本用纯字符串：兼容性最好（部分网关对类型化 content 块翻译有坑）
    input.push({ role: m.role as 'user' | 'assistant', content: m.content ?? '' });
  }
  return {
    model: params.model,
    ...(instructions ? { instructions } : {}),
    input,
    ...(params.tools?.length
      ? { tools: params.tools.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })) }
      : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** Responses 响应 JSON → 内部消息（output 项里取文本与 function_call） */
export function fromResponsesResponse(json: { status?: string; error?: { message?: string }; output?: { type: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; arguments?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }): ChatResult {
  if (json.error || (json.status && json.status !== 'completed')) throw new Error(`Responses 请求未完成: ${json.status ?? ''} ${json.error?.message ?? ''}`);
  if (!Array.isArray(json.output) || !json.output.length) throw new Error('Responses 响应缺少 output');
  const text: string[] = [];
  const tool_calls: ToolCall[] = [];
  for (const item of json.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) text.push(c.text);
      }
    } else if (item.type === 'function_call') {
      tool_calls.push({ id: item.call_id ?? '', type: 'function', function: { name: item.name ?? '', arguments: item.arguments ?? '{}' } });
    }
  }
  return {
    message: { content: text.join('') || null, tool_calls },
    usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
  };
}

/**
 * Responses SSE 聚合器（纯逻辑，可单测）：
 * output_text.delta 累积正文；output_item.done 交付完整 function_call（无需增量拼参数）；response.completed 带最终 usage。
 */
export class ResponsesStreamAccumulator {
  content = '';
  completed = false;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  private calls: { id: string; name: string; arguments: string }[] = [];

  push(evt: { type: string; delta?: string; item?: { type: string; call_id?: string; name?: string; arguments?: string }; response?: { usage?: { input_tokens?: number; output_tokens?: number } } }): void {
    switch (evt.type) {
      case 'response.output_text.delta':
        if (evt.delta) this.content += evt.delta;
        break;
      case 'response.output_item.done':
        if (evt.item?.type === 'function_call') {
          this.calls.push({ id: evt.item.call_id ?? '', name: evt.item.name ?? '', arguments: evt.item.arguments ?? '{}' });
        }
        break;
      case 'response.completed':
        this.completed = true;
        if (evt.response?.usage) {
          this.usage = { inputTokens: evt.response.usage.input_tokens ?? 0, outputTokens: evt.response.usage.output_tokens ?? 0 };
        }
        break;
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        throw new Error(`Responses 流式请求未完成: ${evt.type}`);
    }
  }

  result(): ChatResult['message'] {
    return {
      content: this.content || null,
      tool_calls: this.calls.map((c, i) => ({ id: c.id || `responses_call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } })),
    };
  }
}

/** OpenAI Responses 协议客户端（如 StepFun 的 step_plan 网关） */
export class ResponsesProvider implements LlmProvider {
  constructor(
    readonly baseURL: string,
    private apiKey: string,
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const url = `${this.baseURL.replace(/\/+$/, '')}/responses`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
    if (params.stream) {
      const res = await postJson(url, { headers, body: toResponsesBody(params, true), signal: params.signal, timeoutMs: params.timeoutMs });
      const acc = new ResponsesStreamAccumulator();
      let emitted = false;
      try {
        for await (const payload of sseDataChunks(res)) {
          if (payload === '[DONE]') continue;
          const evt = JSON.parse(payload) as Parameters<ResponsesStreamAccumulator['push']>[0];
          const before = acc.content;
          acc.push(evt);
          if (acc.content !== before) {
            emitted = true;
            params.onDelta?.(acc.content.slice(before.length));
          }
        }
        if (!acc.completed) throw new Error('Responses 流被截断：缺少 response.completed');
      } catch (e) {
        if (emitted) (e as { noRetry?: boolean }).noRetry = true;
        throw e;
      }
      const message = acc.result();
      if (acc.usage) return { message, usage: acc.usage };
      return { message, usage: estimateUsage(params.messages, message), usageEstimated: true };
    }
    const res = await postJson(url, { headers, body: toResponsesBody(params, false), signal: params.signal, timeoutMs: params.timeoutMs });
    const json = await responseJson(res) as Parameters<typeof fromResponsesResponse>[0];
    const result = fromResponsesResponse(json);
    return json.usage ? result : { ...result, usage: estimateUsage(params.messages, result.message), usageEstimated: true };
  }
}
