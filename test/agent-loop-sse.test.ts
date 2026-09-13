import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { runUserTurn } from '../src/core/loop.js';
import { loadConfig } from '../src/config.js';
import { QuietUi } from '../src/ui/render.js';
import { startSseServer, sendSse, sseChunk, sseDone } from './helpers/sse-server.js';

/**
 * 闭合"默认开启流式路径"的运行时缺口：agent loop 的每一次 LLM 调用
 * 都经真实 SSE 服务器流式返回（tool_call 分片 + usage 尾块），而非 mock。
 * 注意：本文件不设 KEEL_MOCK，Router 会真正实例化 OpenAICompatProvider。
 */

function fragment(id: string, name: string, argA: string, argB: string): string[] {
  return [
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: argA } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argB } }] } }] }),
  ];
}

test('全链路（真实 SSE）: loop 经本地流式服务完成 write → verify → done', async () => {
  const server = await startSseServer((i, _body, res) => {
    if (i === 0) {
      sendSse(res, [
        ...fragment('c1', 'write', '{"path":"hello.txt",', '"content":"hello sse\\n"}'),
        sseChunk({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } }),
        sseDone(),
      ]);
    } else if (i === 1) {
      sendSse(res, [
        ...fragment('c2', 'verify', '{"commands":["node -e \\"process.exit', '(0)\\""]}',),
        sseChunk({ choices: [], usage: { prompt_tokens: 220, completion_tokens: 30 } }),
        sseDone(),
      ]);
    } else {
      sendSse(res, [
        sseChunk({ choices: [{ delta: { content: '任务完成：SSE 完整通路验证通过。' } }] }),
        sseChunk({ choices: [], usage: { prompt_tokens: 320, completion_tokens: 20 } }),
        sseDone(),
      ]);
    }
  });

  process.env.KEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-home-sse-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cwd-sse-'));
  const { cfg } = loadConfig(cwd);
  cfg.providers.ssetest = { baseURL: server.url, apiKeyEnv: 'SSE_TEST_KEY' };
  process.env.SSE_TEST_KEY = 'k';
  cfg.router.main = 'ssetest/sse-model';
  cfg.router.fast = 'ssetest/sse-model';
  cfg.llm.stream = true;
  cfg.llm.retries = 0;

  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive: false });
  store.append('session.started', { cwd, gitBranch: null, model: cfg.router.main, interactive: false });
  const ui = new QuietUi();

  try {
    const summary = await runUserTurn({ store, cfg, ui, interactive: false, userText: '写 hello 文件并验证', autoApprove: true });

    assert.equal(summary.stopReason, 'done');
    assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hello sse\n');

    // 流式文本确实经 onDelta 到达
    assert.ok(ui.streamed.join('').includes('SSE 完整通路'), '完成文本应经流式增量到达');

    // usage 尾块经 SSE 透传进事件流，且未被标记为估算
    const responses = store.readAll().filter((e) => e.type === 'llm.response');
    assert.equal(responses.length, 3, '三次 LLM 调用（write/verify/done）');
    for (const r of responses) {
      assert.equal(r.data.usageEstimated, false);
      assert.ok(r.data.usage.inputTokens > 0, 'usage 来自 SSE 尾块而非估算');
    }
    assert.ok(store.readAll().some((e) => e.type === 'verify.result' && e.data.ok === true));
    assert.equal(server.requestCount(), 3);
  } finally {
    await server.close();
  }
});
