import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { fold } from '../src/core/fold.js';
import { forkSession } from '../src/commands.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-home-'));
process.env.KEEL_HOME = home;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cwd-'));

function makeStore(): SessionStore {
  const store = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
  store.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
  return store;
}

test('fold: 从事件流重建消息、花费与验证状态', () => {
  const store = makeStore();
  store.append('user.message', { text: '帮我写个工具' });
  store.append('llm.response', {
    role: 'main',
    model: 'deepseek-chat',
    content: '好的，我来写入文件',
    toolCalls: [{ id: 'c1', name: 'write', arguments: '{"path":"a.txt"}' }],
    usage: { inputTokens: 1000, outputTokens: 100 },
    costUsd: 0.002,
    latencyMs: 10,
    inHistory: true,
  });
  store.append('tool.call', { toolCallId: 'c1', tool: 'write', input: { path: 'a.txt' } });
  store.append('tool.result', { toolCallId: 'c1', tool: 'write', ok: true, output: '创建了 a.txt', durationMs: 2 });
  store.append('verify.result', { ok: true, results: [] });
  store.append('turn.completed', { stopReason: 'done', evidenceOk: null, turns: 1, spendUsd: 0.002 });

  const st = fold(store.readAll());
  assert.deepEqual(
    st.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.equal(st.messages[1]?.tool_calls?.[0]?.function.name, 'write');
  assert.equal(st.spend.totalUsd, 0.002);
  assert.equal(st.lastFileModSeq > 0, true);
  assert.equal(st.lastVerifyOkSeq > st.lastFileModSeq, true, '验证通过应晚于文件修改');
  assert.equal(st.filesTouched.includes('a.txt'), true);
  assert.equal(st.turns, 1);
  assert.equal(st.title, '帮我写个工具');
});

test('fold: 被拒绝的写入不算文件修改', () => {
  const store = makeStore();
  store.append('user.message', { text: '读 .env' });
  store.append('llm.response', {
    role: 'main',
    model: 'deepseek-chat',
    content: null,
    toolCalls: [{ id: 'c2', name: 'read', arguments: '{"path":".env"}' }],
    usage: { inputTokens: 10, outputTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    inHistory: true,
  });
  store.append('tool.result', { toolCallId: 'c2', tool: 'read', ok: false, output: '被策略拒绝', durationMs: 0 });
  const st = fold(store.readAll());
  assert.equal(st.lastFileModSeq, 0);
});

test('fold: 压缩事件替换视图但保留近期消息', () => {
  const store = makeStore();
  store.append('user.message', { text: '早期任务' });
  store.append('context.compacted', {
    upToSeq: store.seq,
    summary: '之前完成了 X',
    keptMessages: [{ role: 'user', content: '近期上下文' }],
  });
  const st = fold(store.readAll());
  assert.equal(st.messages.length, 2);
  assert.match(st.messages[0]!.content!, /之前完成了 X/);
  assert.equal(st.messages[1]!.content, '近期上下文');
  assert.equal(st.compactUpToSeq, store.seq - 1);
});

test('fork: 复制事件前缀并在断点后继续', () => {
  const parent = makeStore();
  for (let i = 0; i < 5; i++) {
    parent.append('user.message', { text: `消息 ${i}` });
  }
  const child = forkSession(parent.id, 3);
  assert.equal(child.id !== parent.id, true);
  assert.equal(child.meta.parent, parent.id);
  assert.equal(child.meta.forkedAtSeq, 3);
  assert.equal(child.seq, 3);
  const childEvents = child.readAll();
  assert.equal(childEvents.length, 3);
  assert.ok(childEvents.every((e) => e.session === child.id), '复制的事件应归属新会话');
  const next = child.append('user.message', { text: '从断点继续' });
  assert.equal(next.seq, 4);
});
