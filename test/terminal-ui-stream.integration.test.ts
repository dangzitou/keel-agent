import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { runUserTurn } from '../src/core/loop.js';
import { loadConfig } from '../src/config.js';
import { TerminalUi } from '../src/ui/render.js';
import { startSseServer, sseChunk } from './helpers/sse-server.js';

test('real SSE partial output is separated from the subsequent runtime error', async () => {
  const server = await startSseServer((_i, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(sseChunk({ choices: [{ delta: { content: 'partial answer' } }] }));
    setTimeout(() => res.destroy(), 30);
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-ui-stream-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const previousHome = process.env.KEEL_HOME;
  const previousKey = process.env.SSE_TEST_KEY;
  process.env.KEEL_HOME = path.join(root, 'home');
  process.env.SSE_TEST_KEY = 'test-key';

  const { cfg } = loadConfig(cwd);
  cfg.providers.ssetest = { baseURL: server.url, apiKeyEnv: 'SSE_TEST_KEY' };
  cfg.router.main = 'ssetest/sse-model';
  cfg.router.fast = 'ssetest/sse-model';
  cfg.llm.stream = true;
  cfg.llm.retries = 0;

  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive: false });
  store.append('session.started', { cwd, gitBranch: null, model: cfg.router.main, interactive: false });
  const chunks: string[] = [];
  const originalLog = console.log;
  const ui = new TerminalUi((text) => chunks.push(text));
  console.log = ((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  }) as typeof console.log;

  try {
    const summary = await runUserTurn({
      store,
      cfg,
      ui,
      interactive: false,
      userText: 'test partial stream failure',
      autoApprove: true,
    });
    const output = chunks.join('');
    assert.equal(summary.stopReason, 'error');
    assert.ok(output.includes('partial answer\n'), JSON.stringify(output));
    assert.ok(output.indexOf('LLM') > output.indexOf('partial answer'), JSON.stringify(output));
    assert.equal((output.match(/partial answer/g) ?? []).length, 1, JSON.stringify(output));
  } finally {
    console.log = originalLog;
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.KEEL_HOME;
    else process.env.KEEL_HOME = previousHome;
    if (previousKey === undefined) delete process.env.SSE_TEST_KEY;
    else process.env.SSE_TEST_KEY = previousKey;
  }
});
