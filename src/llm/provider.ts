import { ChatParams, ChatResult, LlmProvider } from './types.js';
import { estimateUsage, httpError, postJson, requestSignal, sseDataChunks } from './http.js';

export { requestSignal, httpError };

/**
 * SSE 增量聚合器（纯逻辑，可单测）：
 * 把 OpenAI 兼容流式 chunk 的 content 增量与 tool_call 分片（按 index 归位）拼成完整消息。
 */
export class StreamAccumulator {
  content = '';
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  private calls = new Map<number, { id: string; name: string; arguments: string }>();

  push(chunk: {
    choices?: {
      delta?: {
        content?: string | null;
        tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }): void {
    if (chunk.usage) this.usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) this.content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const cur = this.calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      this.calls.set(tc.index, cur);
    }
  }

  result(): { content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] } {
    const tool_calls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id || `stream_call_${index}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments || '{}' },
      }));
    return { content: this.content || null, tool_calls };
  }
}

/** OpenAI 兼容 chat/completions 客户端：DeepSeek/GLM/Kimi/Qwen/OpenAI 通吃，支持流式与超时 */
export class OpenAICompatProvider implements LlmProvider {
  constructor(
    readonly baseURL: string,
    private apiKey: string,
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    if (params.stream) return this.chatStream(params);
    return this.chatOnce(params);
  }

  private async post(params: ChatParams, body: Record<string, unknown>): Promise<Response> {
    const url = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;
    return postJson(url, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
  }

  private static buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    return {
      model: params.model,
      messages: params.messages,
      ...(params.tools?.length ? { tools: params.tools, tool_choice: 'auto' } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async chatOnce(params: ChatParams): Promise<ChatResult> {
    const res = await this.post(params, OpenAICompatProvider.buildBody(params, false));
    const json = (await res.json()) as {
      choices?: { message?: { content: string | null; tool_calls?: unknown[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error(`LLM 响应缺少 choices[0].message: ${JSON.stringify(json).slice(0, 300)}`);
    const tool_calls = (msg.tool_calls ?? []) as {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }[];
    return {
      message: { content: msg.content ?? null, tool_calls },
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async chatStream(params: ChatParams): Promise<ChatResult> {
    const res = await this.post(params, OpenAICompatProvider.buildBody(params, true));
    if (!res.body) throw new Error('流式响应缺少 body');
    const acc = new StreamAccumulator();
    let emitted = false;
    try {
      for await (const payload of sseDataChunks(res)) {
        try {
          const chunk = JSON.parse(payload);
          const before = acc.content;
          acc.push(chunk);
          if (acc.content !== before) {
            emitted = true;
            params.onDelta?.(acc.content.slice(before.length));
          }
        } catch {
          /* 非 JSON 心流行，忽略 */
        }
      }
    } catch (e) {
      // 已经流出一部分文本后再失败：重试会导致输出重复，标记为不可重试
      if (emitted) (e as { noRetry?: boolean }).noRetry = true;
      throw e;
    }

    const message = acc.result();
    if (acc.usage?.prompt_tokens != null || acc.usage?.completion_tokens != null) {
      return {
        message,
        usage: { inputTokens: acc.usage.prompt_tokens ?? 0, outputTokens: acc.usage.completion_tokens ?? 0 },
      };
    }
    // 兼容不支持 include_usage 的服务：估算并标记
    return { message, usage: estimateUsage(params.messages, message), usageEstimated: true };
  }
}

type MockStep = (calls: number) => ChatResult;

/** 测试可注入自定义 mock 脚本（进程级） */
let customMockScript: MockStep[] | null = null;
export function setMockScript(script: MockStep[] | null): void {
  customMockScript = script;
}

/**
 * 确定性 mock provider：按调用次数走脚本，用于零成本测试整个 harness
 * （loop / 事件流 / 完成契约 / 计费），也是无网环境的演示模式（KEEL_MOCK=1）。
 */
export class MockProvider implements LlmProvider {
  private calls = 0;

  constructor(private script: MockStep[] = defaultMockScript()) {}

  async chat(_params: ChatParams): Promise<ChatResult> {
    const script = customMockScript ?? this.script;
    const step = script[Math.min(this.calls, script.length - 1)]!;
    this.calls += 1;
    return step(this.calls);
  }
}

function mockResult(message: ChatResult['message']): ChatResult {
  return { message, usage: { inputTokens: 1200, outputTokens: 260 } };
}

export function defaultMockScript(): MockStep[] {
  return [
    () =>
      mockResult({
        content: null,
        tool_calls: [
          {
            id: 'mock-call-1',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ path: 'hello.txt', content: 'hello from keel\n' }),
            },
          },
        ],
      }),
    () =>
      mockResult({
        content: null,
        tool_calls: [
          {
            id: 'mock-call-2',
            type: 'function',
            function: {
              name: 'verify',
              arguments: JSON.stringify({
                commands: ['node -e "process.stdout.write(\'verify-ok\')"'],
              }),
            },
          },
        ],
      }),
    () =>
      mockResult({
        content: '任务完成：已写入 hello.txt，验证命令输出 verify-ok，通过。',
        tool_calls: [],
      }),
  ];
}
