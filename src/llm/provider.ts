import { ChatParams, ChatResult, LlmProvider } from './types.js';

/** OpenAI 兼容 chat/completions 客户端：DeepSeek/GLM/Kimi/Qwen/OpenAI 通吃 */
export class OpenAICompatProvider implements LlmProvider {
  constructor(
    readonly baseURL: string,
    private apiKey: string,
  ) {}

  async chat(params: ChatParams): Promise<ChatResult> {
    const url = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          ...(params.tools?.length ? { tools: params.tools, tool_choice: 'auto' } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        }),
      });
    } catch (e) {
      throw new Error(`无法连接 ${url}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM 请求失败 HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
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
