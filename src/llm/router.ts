import { KeelConfig } from '../config.js';
import { ChatMessage, ChatResult, LlmProvider, ToolSchema } from './types.js';
import { OpenAICompatProvider, MockProvider } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { ResponsesProvider } from './responses.js';
import { costFor } from './cost.js';
import { withRetry } from './retry.js';

export interface ChatCallOpts {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  onRetry?: (failedAttempt: number, error: Error, delayMs: number) => void;
}

/** 模型路由 + 计费入口。所有 LLM 调用都经过这里：重试、超时、流式、成本归因集中处理。 */
export class Router {
  private cache = new Map<string, { modelRef: string; model: string; provider: LlmProvider }>();

  constructor(private cfg: KeelConfig) {}

  modelRef(role: 'main' | 'fast'): string {
    return role === 'main' ? this.cfg.router.main : this.cfg.router.fast;
  }

  private resolve(role: 'main' | 'fast'): { modelRef: string; model: string; provider: LlmProvider } {
    const cached = this.cache.get(role);
    if (cached) return cached;

    const modelRef = this.modelRef(role);
    const slash = modelRef.indexOf('/');
    if (slash < 1) {
      throw new Error(`router.${role}="${modelRef}" 格式应为 "provider/model"`);
    }
    const providerName = modelRef.slice(0, slash);
    const model = modelRef.slice(slash + 1);
    const pcfg = this.cfg.providers[providerName];
    if (!pcfg) {
      throw new Error(
        `未知 provider "${providerName}"（router.${role}=${modelRef}）。可用: ${Object.keys(this.cfg.providers).join(', ')}`,
      );
    }

    let provider: LlmProvider;
    if (process.env.KEEL_MOCK === '1') {
      provider = new MockProvider();
    } else {
      const key = process.env[pcfg.apiKeyEnv];
      if (!key) {
        throw new Error(
          `provider "${providerName}" 需要 API key：请设置环境变量 ${pcfg.apiKeyEnv}（baseURL=${pcfg.baseURL}），或用 KEEL_MOCK=1 体验 mock 模式`,
        );
      }
      const api = pcfg.api ?? 'openai';
      provider =
        api === 'anthropic'
          ? new AnthropicProvider(pcfg.baseURL, key)
          : api === 'responses'
            ? new ResponsesProvider(pcfg.baseURL, key)
            : new OpenAICompatProvider(pcfg.baseURL, key);
    }

    const entry = { modelRef, model, provider };
    this.cache.set(role, entry);
    return entry;
  }

  /** 发起一次对话：重试 + 超时 + 可选流式，返回折算成本后的结果 */
  async chat(
    role: 'main' | 'fast',
    messages: ChatMessage[],
    tools?: ToolSchema[],
    opts: ChatCallOpts = {},
  ): Promise<ChatResult & { model: string; costUsd: number; latencyMs: number }> {
    const { modelRef, model, provider } = this.resolve(role);
    const params = {
      model,
      messages,
      tools,
      stream: Boolean(opts.onDelta) && this.cfg.llm.stream,
      onDelta: opts.onDelta,
      signal: opts.signal,
      timeoutMs: this.cfg.llm.timeoutMs,
    };
    const t0 = Date.now();
    const { result } = await withRetry((attempt) => provider.chat(params), {
      retries: this.cfg.llm.retries,
      signal: opts.signal,
      onRetry: opts.onRetry,
    });
    const latencyMs = Date.now() - t0;
    const costUsd = costFor(modelRef, result.usage.inputTokens, result.usage.outputTokens);
    return { ...result, model, costUsd, latencyMs };
  }
}
