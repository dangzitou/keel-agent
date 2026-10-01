import { PlanStatus } from '../events/types.js';
import { ToolCtx, ToolDef, ToolOutput } from './types.js';

const STATUSES: PlanStatus[] = ['pending', 'in_progress', 'done'];

const MARK: Record<PlanStatus, string> = { pending: '·', in_progress: '▸', done: '✓' };

function normalizeStep(s: unknown): { text: string; status: PlanStatus } | null {
  if (typeof s !== 'object' || s === null) return null;
  const text = String((s as Record<string, unknown>).text ?? '').trim();
  if (!text) return null;
  const raw = String((s as Record<string, unknown>).status ?? 'pending');
  return { text, status: (STATUSES as string[]).includes(raw) ? (raw as PlanStatus) : 'pending' };
}

/**
 * plan 规划工具：多步骤任务的步骤清单。
 * 与把计划塞进对话文本不同，每次更新都作为 plan.updated 事件落盘——
 * 计划的演变可回放，fork 到任意事件得到的计划状态与当时完全一致。
 */
export const planTool: ToolDef = {
  name: 'plan',
  description:
    '制定或更新任务计划（快照式全量替换）。计划是会话事件流的一部分：可回放、可审计，fork 后计划状态随之回溯。' +
    '开始多步骤任务时应先建计划；完成一步或方向变化时及时更新。',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: '完整步骤列表（替换旧计划），每项含 text 与 status(pending|in_progress|done)',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '步骤内容' },
            status: { type: 'string', enum: STATUSES, description: '默认 pending' },
          },
          required: ['text'],
        },
      },
    },
    required: ['steps'],
  },
  async run(input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
    const raw = Array.isArray(input.steps) ? input.steps : [];
    const steps = raw.map(normalizeStep).filter((s): s is { text: string; status: PlanStatus } => s !== null);
    if (!steps.length) return { ok: false, output: 'plan.steps 为空或格式不合法（每项需非空 text）' };

    await ctx.store.append('plan.updated', { steps });

    const done = steps.filter((s) => s.status === 'done').length;
    const current = steps.find((s) => s.status === 'in_progress');
    const body = steps.map((s) => `${MARK[s.status]} ${s.text}`).join('\n');
    return {
      ok: true,
      output: `计划已落盘（${done}/${steps.length} 完成${current ? `，当前: ${current.text}` : ''}）\n${body}`,
    };
  },
};
