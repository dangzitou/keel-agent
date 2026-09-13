import fs from 'node:fs';
import path from 'node:path';
import { ToolCtx, ToolDef, ToolOutput } from './types.js';
import { VerifyCommandResult, VerifyResultData } from '../events/types.js';
import { bashTool } from './builtin.js';

/**
 * verify：完成契约的执行端。跑验证命令、生成证据（事件 + evidence/ 文件）。
 * harness 在 agent 声明完成时检查"最后一次文件修改之后是否有通过的证据"。
 */
export const verifyTool: ToolDef = {
  name: 'verify',
  description:
    '运行验证命令（测试/构建/脚本）并保存证据。commands 不传时用项目 .keel.json 里的 verify.commands。修改文件后、声明完成前必须调用本工具且通过。',
  parameters: {
    type: 'object',
    properties: {
      commands: {
        type: 'array',
        items: { type: 'string' },
        description: '要执行的验证命令列表（默认用配置中的 verify.commands）',
      },
    },
  },
  run: async (input, ctx: ToolCtx): Promise<ToolOutput> => {
    const commands = (Array.isArray(input.commands) && input.commands.length
      ? input.commands.map(String)
      : ctx.cfg.verify.commands) as string[];
    if (!commands.length) {
      return {
        ok: false,
        output:
          '没有可用的验证命令：请在 .keel.json 配置 verify.commands（如 ["npm test"]），或调用 verify 时显式传入 commands。',
      };
    }

    ctx.store.append('verify.started', { commands });

    const results: VerifyCommandResult[] = [];
    for (const cmd of commands) {
      const t0 = Date.now();
      const r = await bashTool.run({ command: cmd, timeoutMs: 300_000 }, ctx);
      results.push({
        command: cmd,
        code: r.exitCode ?? (r.ok ? 0 : 1),
        durationMs: Date.now() - t0,
        outputExcerpt: r.output.split('\n').slice(-30).join('\n').slice(0, 2000),
      });
    }

    const ok = results.every((r) => r.code === 0);
    const data: VerifyResultData = { ok, results };
    const ev = ctx.store.append('verify.result', data);

    // 证据落盘：evidence/<seq>.json
    try {
      fs.writeFileSync(
        path.join(ctx.store.evidenceDir(), `${ev.seq}.json`),
        JSON.stringify({ seq: ev.seq, ts: ev.ts, ok, results }, null, 2),
        'utf8',
      );
    } catch {
      /* 证据文件写失败不影响主流程，事件里已有 */
    }

    const lines = results.map((r) => `${r.code === 0 ? '✓' : '✗'} ${r.command}（exit ${r.code}）`);
    const failed = results.filter((r) => r.code !== 0);
    const detail = failed.length
      ? '\n失败输出（末尾）:\n' + failed.map((r) => `--- ${r.command} ---\n${r.outputExcerpt}`).join('\n')
      : '';
    return { ok, output: lines.join('\n') + detail };
  },
};
