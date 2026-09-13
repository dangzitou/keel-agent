import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatProvider } from '../src/llm/provider.js';
import { startSseServer, sendSse, sseChunk, sseDone } from './helpers/sse-server.js';

/**
 * 运行时闭合 chatStream 缺口：OpenAICompatProvider 指向本地 SSE 服务器，
 * 消费真实的分块到达的 SSE 流（此前 StreamAccumulator 只有纯解析器单测，
 * mock 模式不走流式，默认开启的 stream:true 主路径从未被执行过）。
 */

test('chatStream 集成: 文本增量 + tool_call 分片 + usage 尾块', async () => {
  const deltas: string[] = [];
  const server = await startSseServer((_i, _body, res) => {
    sendSse(res, [
      sseChunk({ choices: [{ delta: { content: '收到，开始写入。' } }] }),
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'write', arguments: '{"path":"he' } }] } }] }),
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'llo.txt","content":"hi"}' } }] } }] }),
      sseChunk({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
      sseDone(),
    ]);
  });
  try {
    const provider = new OpenAICompatProvider(server.url, 'test-key');
    const res = await provider.chat({
      model: 'sse-model',
      messages: [{ role: 'user', content: '写个文件' }],
      stream: true,
      onDelta: (t) => deltas.push(t),
    });
    assert.equal(res.message.content, '收到，开始写入。');
    assert.deepEqual(res.message.tool_calls, [
      { id: 'call_a', type: 'function', function: { name: 'write', arguments: '{"path":"hello.txt","content":"hi"}' } },
    ]);
    assert.deepEqual(res.usage, { inputTokens: 42, outputTokens: 7 });
    assert.equal(res.usageEstimated, undefined, 'usage 尾块存在时不应标记估算');
    assert.deepEqual(deltas, ['收到，开始写入。'], 'onDelta 应收到文本增量');
  } finally {
    await server.close();
  }
});

test('chatStream 集成: 服务端不回 usage 时估算并标记 usageEstimated', async () => {
  const server = await startSseServer((_i, _body, res) => {
    sendSse(res, [
      sseChunk({ choices: [{ delta: { content: '一点内容，用于估算输出 token。' } }] }),
      sseDone(),
    ]);
  });
  try {
    const provider = new OpenAICompatProvider(server.url, 'test-key');
    const res = await provider.chat({
      model: 'sse-model',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    });
    assert.equal(res.usageEstimated, true);
    assert.ok(res.usage.outputTokens > 0, '输出 token 应按字符估算');
    assert.ok(res.usage.inputTokens > 0, '输入 token 应按消息长度估算');
  } finally {
    await server.close();
  }
});

test('chatStream 集成: HTTP 500 + Retry-After 透传为可重试错误', async () => {
  const server = await startSseServer((_i, _body, res) => {
    res.writeHead(500, { 'retry-after': '2' });
    res.end('boom');
  });
  try {
    const provider = new OpenAICompatProvider(server.url, 'test-key');
    await assert.rejects(
      provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }),
      (e: unknown) => {
        const err = e as { status?: number; retryAfterMs?: number; message?: string };
        return err.status === 500 && err.retryAfterMs === 2000 && /HTTP 500/.test(err.message ?? '');
      },
    );
  } finally {
    await server.close();
  }
});

test('chatStream 集成: 超时中断挂起的服务端（requestSignal 组合链路）', async () => {
  const server = await startSseServer((_i, _body, _res) => {
    /* 永不响应 */
  });
  try {
    const provider = new OpenAICompatProvider(server.url, 'test-key');
    const t0 = Date.now();
    await assert.rejects(
      provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true, timeoutMs: 200 }),
      /abort/i,
    );
    assert.ok(Date.now() - t0 < 5000, '应在超时后快速失败，而不是挂死');
  } finally {
    await server.close();
  }
});
