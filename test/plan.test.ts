import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { fold } from '../src/core/fold.js';
import { planTool } from '../src/tools/plan.js';
import { defaultConfig } from '../src/config.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-plan-home-'));
process.env.KEEL_HOME = home;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-plan-cwd-'));

function makeStore(): SessionStore {
  const store = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
  store.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
  return store;
}

const ctx = { cwd, cfg: defaultConfig(), store: null as unknown as SessionStore, interactive: false };

test('plan 工具：落 plan.updated 事件，fold 推导当前计划', async () => {
  const store = makeStore();
  const out = await planTool.run(
    { steps: [{ text: '探索仓库', status: 'done' }, { text: '写实现', status: 'in_progress' }, { text: '跑验证' }] },
    { ...ctx, store },
  );
  assert.equal(out.ok, true);
  assert.match(out.output, /1\/3 完成/);
  assert.match(out.output, /▸ 写实现/);

  const st = fold(store.readAll());
  assert.equal(st.plan?.length, 3);
  assert.equal(st.plan?.[1]?.status, 'in_progress');
  assert.equal(st.plan?.[2]?.status, 'pending'); // 缺省 status 归一为 pending
});

test('plan 是快照替换：事件流保留全部历史版本，fold 只看最后一份', async () => {
  const store = makeStore();
  await planTool.run({ steps: [{ text: '旧步骤一' }, { text: '旧步骤二' }] }, { ...ctx, store });
  await planTool.run({ steps: [{ text: '新计划', status: 'in_progress' }] }, { ...ctx, store });

  const updates = store.readAll().filter((e) => e.type === 'plan.updated');
  assert.equal(updates.length, 2); // 审计：两次演变都在流里
  assert.equal(fold(store.readAll()).plan?.[0]?.text, '新计划');
});

test('plan 非法输入被拒绝且不落事件', async () => {
  const store = makeStore();
  const out = await planTool.run({ steps: [{ text: '' }, 'x'] }, { ...ctx, store });
  assert.equal(out.ok, false);
  assert.equal(store.readAll().filter((e) => e.type === 'plan.updated').length, 0);
});

test('fork 回溯后计划状态与当时一致', async () => {
  const store = makeStore();
  await planTool.run({ steps: [{ text: '步骤一' }, { text: '步骤二' }] }, { ...ctx, store });
  const atSeq = store.seq; // 此时只有第一版计划
  await planTool.run({ steps: [{ text: '推翻重来' }] }, { ...ctx, store });
  assert.equal(fold(store.readAll()).plan?.[0]?.text, '推翻重来');

  const { forkSession } = await import('../src/commands.js');
  const child = forkSession(store.id, atSeq);
  assert.equal(fold(child.readAll()).plan?.length, 2); // 回到 fork 点的第一版计划
});
