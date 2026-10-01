import { SessionStore } from '../core/store.js';
import { ToolCall, ToolSchema } from '../llm/types.js';
import { bashTool, editTool, globTool, grepTool, readTool, writeTool } from './builtin.js';
import { verifyTool } from './verify.js';
import { planTool } from './plan.js';
import { ToolCtx, ToolDef, ToolOutput } from './types.js';

export type { ToolCtx, ToolDef, ToolOutput } from './types.js';

const registry: ToolDef[] = [planTool, readTool, writeTool, editTool, bashTool, globTool, grepTool, verifyTool];

export const TOOLS: Map<string, ToolDef> = new Map(registry.map((t) => [t.name, t]));

export const TOOL_SCHEMAS: ToolSchema[] = registry.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export const TOOL_NAMES = registry.map((t) => t.name);

export async function executeToolCall(call: ToolCall, ctx: ToolCtx): Promise<ToolOutput> {
  const def = TOOLS.get(call.function.name);
  if (!def) return { ok: false, output: `未知工具: ${call.function.name}` };
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(call.function.arguments || '{}');
  } catch (e) {
    return { ok: false, output: `工具参数不是合法 JSON: ${(e as Error).message}` };
  }
  try {
    return await def.run(input, ctx);
  } catch (e) {
    return { ok: false, output: `工具执行异常: ${(e as Error).stack ?? e}` };
  }
}
