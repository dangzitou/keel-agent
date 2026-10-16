import { checkPolicy } from '../policy/policy.js';
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

/** Validate the schema subset used by built-in tools at the model trust boundary. */
function validate(value: unknown, schema: any, key: string): void {
  const valid = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'integer' ? Number.isSafeInteger(value)
    : typeof value === schema.type;
  if (!valid || (schema.enum && !schema.enum.includes(value))) throw new Error(`${key} 参数类型或取值不合法`);
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in object)) throw new Error(`缺少参数 ${key}.${required}`);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in object) validate(object[name], child, `${key}.${name}`);
    }
  }
  if (schema.type === 'array') (value as unknown[]).forEach((item, i) => validate(item, schema.items, `${key}[${i}]`));
}

export function parseToolInput(call: ToolCall): Record<string, unknown> {
  const def = TOOLS.get(call.function.name);
  if (!def) throw new Error(`未知工具: ${call.function.name}`);
  const input = JSON.parse(call.function.arguments || '{}');
  validate(input, def.parameters, call.function.name);
  return input;
}

export async function executeToolCall(call: ToolCall, ctx: ToolCtx): Promise<ToolOutput> {
  const def = TOOLS.get(call.function.name);
  if (!def) return { ok: false, output: `未知工具: ${call.function.name}` };
  let input: Record<string, unknown>;
  try {
    input = parseToolInput(call);
  } catch (e) {
    return { ok: false, output: `工具参数错误: ${(e as Error).message}` };
  }
  try {
    if (ctx.signal?.aborted) return { ok: false, output: '操作已中断' };
    const verdict = checkPolicy(ctx.cfg.policy, { tool: def.name, input, cwd: ctx.cwd, verifyCommands: ctx.cfg.verify.commands });
    if (verdict.decision === 'deny' || (verdict.decision === 'approve' && !ctx.approved)) {
      return { ok: false, output: `被策略拒绝或尚未审批: ${verdict.rule}` };
    }
    return await def.run(input, ctx);
  } catch (e) {
    return { ok: false, output: `工具执行异常: ${(e as Error).stack ?? e}` };
  }
}
