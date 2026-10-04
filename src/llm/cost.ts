/** 计费表：USD / 每百万 token。可按需增改，未收录模型按 0 计（仪表盘会提示未知价目）。 */
export const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'glm-4.6': { input: 0.6, output: 2.2 },
  'glm-4.5': { input: 0.6, output: 2.2 },
  'glm-4.5-air': { input: 0.11, output: 0.44 },
  'glm-4-flash': { input: 0, output: 0 },
  'qwen-max': { input: 1.6, output: 6.4 },
  'qwen-plus': { input: 0.4, output: 1.2 },
  'qwen-turbo': { input: 0.05, output: 0.2 },
  'kimi-k2-0711-preview': { input: 0.6, output: 2.5 },
  'kimi-k2-turbo-preview': { input: 1.15, output: 8 },
  'step-5-preview': { input: 1, output: 2.7 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'mock-model': { input: 0.01, output: 0.03 },
};

/** "deepseek/deepseek-chat" -> "deepseek-chat" */
export function bareModel(modelRef: string): string {
  const i = modelRef.indexOf('/');
  return i >= 0 ? modelRef.slice(i + 1) : modelRef;
}

export function costFor(modelRef: string, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_MTOK[bareModel(modelRef)];
  if (!p) return 0;
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

export function hasKnownPrice(modelRef: string): boolean {
  return bareModel(modelRef) in PRICE_PER_MTOK;
}
