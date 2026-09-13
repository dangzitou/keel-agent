import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamAccumulator } from '../src/llm/provider.js';

test('StreamAccumulator: content 增量拼接', () => {
  const acc = new StreamAccumulator();
  acc.push({ choices: [{ delta: { content: '你' } }] });
  acc.push({ choices: [{ delta: { content: '好' } }] });
  acc.push({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const r = acc.result();
  assert.equal(r.content, '你好');
  assert.deepEqual(r.tool_calls, []);
  assert.deepEqual(acc.usage, { prompt_tokens: 10, completion_tokens: 2 });
});

test('StreamAccumulator: tool_call 分片按 index 归位并拼接参数', () => {
  const acc = new StreamAccumulator();
  acc.push({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write', arguments: '{"pa' } }],
        },
      },
    ],
  });
  acc.push({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }],
  });
  acc.push({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 1, id: 'call_2', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
        },
      },
    ],
  });
  const { tool_calls } = acc.result();
  assert.equal(tool_calls.length, 2);
  assert.deepEqual(tool_calls[0], {
    id: 'call_1',
    type: 'function',
    function: { name: 'write', arguments: '{"path":"a.txt"}' },
  });
  assert.equal(tool_calls[1]!.id, 'call_2');
  assert.equal(tool_calls[1]!.function.name, 'bash');
});

test('StreamAccumulator: 无 id 分片生成兜底 id，空参数兜底 {}', () => {
  const acc = new StreamAccumulator();
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 3, function: { name: 'read' } }] } }] });
  const { tool_calls } = acc.result();
  assert.equal(tool_calls[0]!.id, 'stream_call_3');
  assert.equal(tool_calls[0]!.function.arguments, '{}');
});
