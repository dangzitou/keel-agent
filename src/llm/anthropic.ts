import { ChatParams, ChatResult, LlmProvider, ToolCall } from './types.js';
import { estimateUsage, postJson, sseDataChunks } from './http.js';

/** 内部消息（OpenAI 风格）→ Anthropic Messages 请求体 */
export function toAnthropicBody(params: ChatParams, stream: boolean): Record<string, unknown> {
  const system: string[] = [];
  const msgs: { role: 'user' | 'assistant'; content: unknown }[] = [];
  for (const m of params.messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
      }
      msgs.push({ role: 'assistant', content: blocks });
      continue;
    }
    msgs.push({ role: m.role, content: m.content ?? '' });
  }
  // Anthropic 不接受相邻同角色消息（tool_result 连续时会出现），合并之
  const merged: typeof msgs = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = mergeContent(last.content, m.content);
    } else {
      merged.push({ ...m });
    }
  }
  return {
    model: params.model,
    max_tokens: 16384,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    messages: merged,
    ...(params.tools?.length
      ? {
          tools: params.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
          tool_choice: { type: 'auto' },
        }
      : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function mergeContent(a: unknown, b: unknown): unknown {
  const arr = [...asBlocks(a), ...asBlocks(b)];
  return arr.length === 1 && typeof arr[0] === 'string' ? arr[0] : arr;
}

function asBlocks(c: unknown): unknown[] {
  if (typeof c === 'string') return c ? [c] : [];
  return Array.isArray(c) ? c : [];
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: s };
  }
}

/** Anthropic 响应 JSON → 内部消息 */
export function fromAnthropicResponse(json: { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number } }): { message: ChatResult['message']; usage: ChatResult['usage'] } {
  const text: string[] = [];
  const tool_calls: ToolCall[] = [];
  for (const b of json.content ?? []) {
    if (b.type === 'text' && b.text) text.push(b.text);
    else if (b.type === 'tool_use') {
      tool_calls.push({ id: b.id ?? '', type: 'function', function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  return {
    message: { content: text.join('') || null, tool_calls },
    usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
  };
}

/**
 * Anthropic SSE 聚合器（纯逻辑，可单测）：
 * text_delta 累积正文；content_block_start 开工具调用、input_json_delta 拼参数；message_delta 带最终 usage。
 */
export class AnthropicStreamAccumulator {
  content = '';
  usage: { inputTokens: number; outputTokens: number } | undefined;
  private blocks = new Map<number, { id: string; name: string; arguments: string }>();

  push(evt: { type: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string }; usage?: { output_tokens?: number }; message?: { usage?: { input_tokens?: number; output_tokens?: number } } }): void {
    switch (evt.type) {
      case 'message_start':
        if (evt.message?.usage) {
          this.usage = { inputTokens: evt.message.usage.input_tokens ?? 0, outputTokens: evt.message.usage.output_tokens ?? 0 };
        }
        break;
      case 'content_block_start':
        if (evt.content_block?.type === 'tool_use' && typeof evt.index === 'number') {
          this.blocks.set(evt.index, { id: evt.content_block.id ?? '', name: evt.content_block.name ?? '', arguments: '' });
        }
        break;
      case 'content_block_delta': {
        const d = evt.delta;
        if (d?.type === 'text_delta' && d.text) this.content += d.text;
        else if (d?.type === 'input_json_delta' && d.partial_json && typeof evt.index === 'number') {
          const cur = this.blocks.get(evt.index) ?? { id: '', name: '', arguments: '' };
          cur.arguments += d.partial_json;
          this.blocks.set(evt.index, cur);
        }
        break;
      }
      case 'message_delta':
        if (evt.usage && this.usage) this.usage.outputTokens = evt.usage.output_tokens ?? this.usage.outputTokens;
        else if (evt.usage) this.usage = { inputTokens: 0, outputTokens: evt.usage.output_tokens ?? 0 };
        break;
    }
  }

  result(): ChatResult['message'] {
    const tool_calls: ToolCall[] = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, b]) => ({ id: b.id || `anthropic_call_${index}`, type: 'function' as const, function: { name: b.name, arguments: b.arguments || '{}' } }));
    return { content: this.content || null, tool_calls };
  }
}

/** Anthropic Messages 协议客户端（如 BigModel 的 /api/anthropic 网关） */
export class AnthropicProvider implements LlmProvider {
  constructor(
    readonly baseURL: string,
    private apiKey: string,
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const url = `${this.baseURL.replace(/\/+$/, '')}/v1/messages`;
    const headers = { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' };
    if (params.stream) {
      const res = await postJson(url, { headers, body: toAnthropicBody(params, true), signal: params.signal, timeoutMs: params.timeoutMs });
      const acc = new AnthropicStreamAccumulator();
      let emitted = false;
      try {
        for await (const payload of sseDataChunks(res)) {
          let evt: Parameters<AnthropicStreamAccumulator['push']>[0];
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          const before = acc.content;
          acc.push(evt);
          if (acc.content !== before) {
            emitted = true;
            params.onDelta?.(acc.content.slice(before.length));
          }
        }
      } catch (e) {
        if (emitted) (e as { noRetry?: boolean }).noRetry = true;
        throw e;
      }
      const message = acc.result();
      if (acc.usage) return { message, usage: acc.usage };
      return { message, usage: estimateUsage(params.messages, message), usageEstimated: true };
    }
    const res = await postJson(url, { headers, body: toAnthropicBody(params, false), signal: params.signal, timeoutMs: params.timeoutMs });
    return fromAnthropicResponse((await res.json()) as Parameters<typeof fromAnthropicResponse>[0]);
  }
}
