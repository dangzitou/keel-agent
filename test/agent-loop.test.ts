import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { fold } from '../src/core/fold.js';
import { runUserTurn } from '../src/core/loop.js';
import { loadConfig } from '../src/config.js';
import { QuietUi } from '../src/ui/render.js';
import { setMockScript } from '../src/llm/provider.js';
import { ChatResult } from '../src/llm/types.js';

process.env.KEEL_MOCK = '1';

function fixture(): { home: string; cwd: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-home-'));
  process.env.KEEL_HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cwd-'));
  return { home, cwd };
}

function mkStore(cwd: string): SessionStore {
  const store = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
  store.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
  return store;
}

function step(content: string | null, tool?: { name: string; args: unknown }, id = 'c'): ChatResult {
  return {
    message: {
      content,
      tool_calls: tool
        ? [{ id: `${id}-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }]
        : [],
    },
    usage: { inputTokens: 1000, outputTokens: 200 },
  };
}

const writeHello = () => step(null, { name: 'write', args: { path: 'hello.txt', content: 'hello from keel\n' } }, 'w');
const verifyPass = () =>
  step(null, { name: 'verify', args: { commands: ['node -e "process.exit(0)"'] } }, 'v');
const done = () => step('任务完成，验证已通过。');

test('全链路: write → verify → done，证据落盘且事件完整', async () => {
  const { cwd } = fixture();
  setMockScript([writeHello, verifyPass, done]);
  const cfg = loadConfig(cwd).cfg;
  const store = mkStore(cwd);
  const ui = new QuietUi();

  const summary = await runUserTurn({ store, cfg, ui, interactive: false, userText: '写个 hello 文件', autoApprove: true });

  assert.equal(summary.stopReason, 'done');
  assert.ok(fs.existsSync(path.join(cwd, 'hello.txt')));

  const events = store.readAll();
  assert.ok(events.some((e) => e.type === 'tool.call' && e.data.tool === 'write'));
  assert.ok(events.some((e) => e.type === 'policy.decision' && e.data.decision === 'allow'));
  const verify = events.find((e) => e.type === 'verify.result');
  assert.ok(verify && verify.data.ok === true, 'verify 应通过');
  assert.ok(fs.existsSync(path.join(store.evidenceDir(), `${verify!.seq}.json`)), '验证证据应落盘 evidence/');

  const st = fold(events);
  assert.ok(st.spend.totalUsd > 0, '费用应被核算');
  assert.ok(st.filesTouched.includes('hello.txt'));
  const completed = events.filter((e) => e.type === 'turn.completed');
  assert.equal(completed.length, 1);
});

test('完成契约: 模型跳过 verify 会被 harness 打回，最终标记 unverified', async () => {
  const { cwd } = fixture();
  setMockScript([writeHello, done]);
  const cfg = loadConfig(cwd).cfg;
  const store = mkStore(cwd);
  const ui = new QuietUi();

  const summary = await runUserTurn({ store, cfg, ui, interactive: false, userText: '写个文件但别验证', autoApprove: true });

  assert.equal(summary.stopReason, 'unverified');
  assert.equal(summary.evidenceOk, false);
  const notes = store.readAll().filter((e) => e.type === 'system.note' && e.data.toModel);
  assert.equal(notes.length, 2, '应打回 MAX_PUSHBACKS 次');
});

test('策略拦截: 拒绝写 .env，模型正常收尾且不算修改', async () => {
  const { cwd } = fixture();
  const writeEnv = () => step(null, { name: 'write', args: { path: '.env', content: 'SECRET=1' } }, 'e');
  setMockScript([writeEnv, done]);
  const cfg = loadConfig(cwd).cfg;
  const store = mkStore(cwd);
  const ui = new QuietUi();

  const summary = await runUserTurn({ store, cfg, ui, interactive: false, userText: '写 .env', autoApprove: true });

  assert.equal(summary.stopReason, 'done');
  assert.ok(!fs.existsSync(path.join(cwd, '.env')), '.env 不应被写入');
  const deny = store.readAll().find((e) => e.type === 'policy.decision' && e.data.decision === 'deny');
  assert.ok(deny, '应有 deny 审计事件');
  assert.equal(fold(store.readAll()).lastFileModSeq, 0, '被拒的写入不算文件修改');
});
