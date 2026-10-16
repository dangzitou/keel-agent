import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { latestSessionId } from '../src/commands.js';
import { autoModelFromEnv, DEFAULT_PROVIDERS, loadConfig } from '../src/config.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-ux-home-'));
process.env.KEEL_HOME = home;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-ux-cwd-'));

/* ---- 智能默认模型 ---- */

test('自动模型：唯一在场的 key 决定默认路由', () => {
  const saved = { ...process.env };
  try {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    delete process.env.STEPFUN_API_KEY;
    assert.equal(autoModelFromEnv(DEFAULT_PROVIDERS, 'deepseek/deepseek-chat'), null); // 无 key 保持默认

    process.env.STEPFUN_API_KEY = 'x';
    assert.equal(autoModelFromEnv(DEFAULT_PROVIDERS, 'deepseek/deepseek-chat'), 'stepfun/step-5-preview');

    process.env.ZHIPU_API_KEY = 'y'; // zhipu 与 glm-anthropic 共用此 env，取 openai 兼容的 zhipu
    delete process.env.STEPFUN_API_KEY;
    assert.equal(autoModelFromEnv(DEFAULT_PROVIDERS, 'deepseek/deepseek-chat'), 'zhipu/glm-4.6');

    process.env.STEPFUN_API_KEY = 'x2'; // 多 key 在场按优先级表取第一个（zhipu 优先于 stepfun）
    assert.equal(autoModelFromEnv(DEFAULT_PROVIDERS, 'deepseek/deepseek-chat'), 'zhipu/glm-4.6');

    delete process.env.STEPFUN_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'z'; // 默认 provider 的 key 在场 → 不切换
    assert.equal(autoModelFromEnv(DEFAULT_PROVIDERS, 'deepseek/deepseek-chat'), null);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('loadConfig：export 一个 ZHIPU key 即开箱即用（auto 路由生效）', () => {
  const saved = { ...process.env };
  try {
    delete process.env.KEEL_MODEL;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.STEPFUN_API_KEY;
    process.env.ZHIPU_API_KEY = 'k';
    const { cfg } = loadConfig(cwd);
    assert.equal(cfg.router.main, 'zhipu/glm-4.6');
  } finally {
    Object.assign(process.env, saved);
  }
});

/* ---- continue / 省略 id ---- */

test('latestSessionId skips a newer empty session', () => {
  const older = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
  older.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
  older.append('user.message', { text: 'older work' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // 确保按创建时间排序
  const recent = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
  recent.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
  recent.append('user.message', { text: 'recent work' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // 确保按创建时间排序
  const empty = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
  empty.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
  assert.equal(latestSessionId(), recent.id);
});

test('latestSessionId rejects when every session is empty', () => {
  const originalHome = process.env.KEEL_HOME;
  process.env.KEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-empty-home-'));
  try {
    const empty = SessionStore.create({ cwd, model: 'deepseek/deepseek-chat', interactive: false });
    empty.append('session.started', { cwd, gitBranch: null, model: 'deepseek/deepseek-chat', interactive: false });
    assert.throws(() => latestSessionId());
  } finally {
    if (originalHome === undefined) delete process.env.KEEL_HOME;
    else process.env.KEEL_HOME = originalHome;
  }
});
