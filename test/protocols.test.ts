import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSseServer, sseChunk, sendSse } from './helpers/sse-server.js';
import { AnthropicProvider, toAnthropicBody, fromAnthropicResponse, AnthropicStreamAccumulator } from '../src/llm/anthropic.js';
import { ResponsesProvider, toResponsesBody, fromResponsesResponse, ResponsesStreamAccumulator } from '../src/llm/responses.js';
import { ChatParams } from '../src/llm/types.js';

const MESSAGES: ChatParams['messages'] = [
  { role: 'system', content: 'sys-prompt' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
  { role: 'tool', content: 'file1', tool_call_id: 't1' },
];

/* ---------------- 纯转换层 ---------------- */

test('anthropic: 请求体转换（system 提取、tool_use/tool_result 映射、相邻同角色合并）', () => {
  const body = toAnthropicBody({ model: 'glm-5.3', messages: MESSAGES }, false) as Record<string, any>;
  assert.equal(body.system, 'sys-prompt');
  assert.equal(body.max_tokens > 0, true);
  const assistant = body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.content[0], { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } });
  const last = body.messages[body.messages.length - 1];
  assert.equal(last.role, 'user'); // tool_result 以 user 角色承载
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 't1');
});

test('anthropic: 响应转换（text + tool_use → 内部消息）', () => {
  const r = fromAnthropicResponse({
    content: [
      { type: 'text', text: '开始' },
      { type: 'tool_use', id: 'a1', name: 'write', input: { path: 'x' } },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  assert.equal(r.message.content, '开始');
  assert.equal(r.message.tool_calls[0].function.arguments, '{"path":"x"}');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 4 });
});

test('responses: 请求体转换（instructions、function_call/output 项）', () => {
  const body = toResponsesBody({ model: 'step-5-preview', messages: MESSAGES }, false) as Record<string, any>;
  assert.equal(body.instructions, 'sys-prompt');
  const types = body.input.map((i: any) => i.type ?? `msg:${i.role}`);
  assert.deepEqual(types, ['msg:user', 'function_call', 'function_call_output']);
  assert.equal(body.input[1].call_id, 't1');
  assert.equal(body.input[2].output, 'file1');
});

test('responses: 响应转换（output_text + function_call 项）', () => {
  const r = fromResponsesResponse({
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      { type: 'function_call', call_id: 'r1', name: 'verify', arguments: '{}' },
    ],
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  assert.equal(r.message.content, 'done');
  assert.equal(r.message.tool_calls[0].id, 'r1');
});

/* ---------------- SSE 聚合层 ---------------- */

test('anthropic SSE 聚合：文本增量、tool_use 参数分片、message_delta usage', () => {
  const acc = new AnthropicStreamAccumulator();
  [
    { type: 'message_start', message: { usage: { input_tokens: 11 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'write' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '.txt"}' } },
    { type: 'message_delta', usage: { output_tokens: 7 } },
  ].forEach((e) => acc.push(e));
  const msg = acc.result();
  assert.equal(msg.content, '你好');
  assert.deepEqual(msg.tool_calls, [{ id: 'tu1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt"}' } }]);
  assert.deepEqual(acc.usage, { inputTokens: 11, outputTokens: 7 });
});

test('responses SSE 聚合：output_text.delta、output_item.done 交付完整 function_call', () => {
  const acc = new ResponsesStreamAccumulator();
  [
    { type: 'response.output_text.delta', delta: '计' },
    { type: 'response.output_text.delta', delta: '划' },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'rc1', name: 'plan', arguments: '{"steps":[]}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 9 } } },
  ].forEach((e) => acc.push(e));
  assert.equal(acc.result().content, '计划');
  assert.equal(acc.result().tool_calls[0].function.name, 'plan');
  assert.deepEqual(acc.usage, { inputTokens: 5, outputTokens: 9 });
});

/* ---------------- 本地 SSE 服务器集成（真实分片流经 provider） ---------------- */

test('AnthropicProvider: 端到点流式（路径、鉴权头、增量回调）', async () => {
  let seenUrl = '';
  let seenKey = '';
  const server = await startSseServer((_i, _body, res, req) => {
    seenUrl = req.url ?? '';
    seenKey = String(req.headers['x-api-key'] ?? '');
    sendSse(res, [
      sseChunk({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
      sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } }),
      sseChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } }),
      sseChunk({ type: 'message_delta', usage: { output_tokens: 2 } }),
      sseChunk({ type: 'message_stop' }),
    ]);
  });
  try {
    // 本地服务 baseURL 已含 /v1；剥掉后再交给 provider，验证它会正确追加 /v1/messages
    const provider = new AnthropicProvider(server.url.replace(/\/v1$/, ''), 'sk-test');
    const deltas: string[] = [];
    const r = await provider.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true, onDelta: (d) => deltas.push(d) });
    assert.equal(seenUrl, '/v1/messages');
    assert.equal(seenKey, 'sk-test');
    assert.equal(r.message.content, 'hello');
    assert.deepEqual(deltas, ['he', 'llo']);
    assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 2 });
  } finally {
    await server.close();
  }
});

test('ResponsesProvider: 端到点流式（路径、Bearer 头）', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const server = await startSseServer((_i, _body, res, req) => {
    seenUrl = req.url ?? '';
    seenAuth = String(req.headers.authorization ?? '');
    sendSse(res, [
      sseChunk({ type: 'response.output_text.delta', delta: 'ok' }),
      sseChunk({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]);
  });
  try {
    const provider = new ResponsesProvider(server.url, 'sk-test');
    const r = await provider.chat({ model: 'step-5-preview', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(seenUrl, '/v1/responses');
    assert.equal(seenAuth, 'Bearer sk-test');
    assert.equal(r.message.content, 'ok');
    assert.equal(r.usageEstimated, undefined); // usage 来自 response.completed，无需估算
  } finally {
    await server.close();
  }
});

test('ResponsesProvider: 非流式 JSON 响应', async () => {
  const server = await startSseServer((_i, _body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '好的' }] }], usage: { input_tokens: 2, output_tokens: 2 } }));
  });
  try {
    const provider = new ResponsesProvider(server.url, 'sk-test');
    const r = await provider.chat({ model: 'step-5-preview', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.message.content, '好的');
    assert.deepEqual(r.usage, { inputTokens: 2, outputTokens: 2 });
  } finally {
    await server.close();
  }
});
