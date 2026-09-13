import { KeelConfig } from '../config.js';
import { ChatMessage, ChatResult, ToolSchema } from './types.js';
import { OpenAICompatProvider, MockProvider } from './provider.js';
import { costFor } from './cost.js';

/** 模型路由 + 计费入口。所有 LLM 调用都经过这里，成本天然可归因。 */
export class Router {
  private cache = new Map<string, { modelRef: string; model: string; provider: OpenAICompatProvider | MockProvider }>();

  constructor(private cfg: KeelConfig) {}

  modelRef(role: 'main' | 'fast'): string {
    return role === 'main' ? this.cfg.router.main : this.cfg.router.fast;
  }

  private resolve(role: 'main' | 'fast'): { modelRef: string; model: string; provider: OpenAICompatProvider | MockProvider } {
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

    let provider: OpenAICompatProvider | MockProvider;
    if (process.env.KEEL_MOCK === '1') {
      provider = new MockProvider();
    } else {
      const key = process.env[pcfg.apiKeyEnv];
      if (!key) {
        throw new Error(
          `provider "${providerName}" 需要 API key：请设置环境变量 ${pcfg.apiKeyEnv}（baseURL=${pcfg.baseURL}），或用 KEEL_MOCK=1 体验 mock 模式`,
        );
      }
      provider = new OpenAICompatProvider(pcfg.baseURL, key);
    }

    const entry = { modelRef, model, provider };
    this.cache.set(role, entry);
    return entry;
  }

  /** 发起一次对话并折算成本 */
  async chat(
    role: 'main' | 'fast',
    messages: ChatMessage[],
    tools?: ToolSchema[],
  ): Promise<ChatResult & { model: string; costUsd: number; latencyMs: number }> {
    const { modelRef, model, provider } = this.resolve(role);
    const t0 = Date.now();
    const res = await provider.chat({ model, messages, tools });
    const latencyMs = Date.now() - t0;
    const costUsd = costFor(modelRef, res.usage.inputTokens, res.usage.outputTokens);
    return { ...res, model, costUsd, latencyMs };
  }
}
