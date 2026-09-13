import { ChatMessage } from '../llm/types.js';

/** 粗估 token 数（中英混合按 ~3 字符/token），只用于决定"何时压缩"，不用于计费 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + 4;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) chars += tc.function.arguments.length + tc.function.name.length;
    }
  }
  return Math.ceil(chars / 3);
}
