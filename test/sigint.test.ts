import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSseServer } from './helpers/sse-server.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 真实信号投递：对 keel run 子进程发 SIGINT（此前只有 AbortController 模拟）。
 * LLM 服务端挂起不响应 → 子进程停在 in-flight fetch 上 → SIGINT →
 * 预期优雅收尾：exit 130 + 事件流落 turn.completed(aborted)。
 */
test('SIGINT 集成: keel run 收到真实 SIGINT 后 exit 130 且 aborted 事件落盘', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = path.join(root, 'dist', 'index.js');
  assert.ok(fs.existsSync(entry), '需先 npm run build 生成 dist/index.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-home-sig-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-cwd-sig-'));

  let seen = 0;
  const server = await startSseServer((_i, _body, _res) => {
    seen += 1; // 永不响应，让子进程挂在 in-flight 请求上
  });

  fs.writeFileSync(
    path.join(cwd, '.keel.json'),
    JSON.stringify({
      providers: { slow: { baseURL: server.url, apiKeyEnv: 'SLOW_KEY' } },
      router: { main: 'slow/slow-model', fast: 'slow/slow-model' },
      llm: { retries: 0, stream: false, timeoutMs: 600000 },
      verify: { commands: ['node -e "process.exit(0)"'] },
    }),
  );

  const child = spawn(process.execPath, [entry, 'run', '慢慢来的任务'], {
    cwd,
    env: { ...process.env, KEEL_HOME: home, SLOW_KEY: 'k' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));

  try {
    // 等服务端看到请求：说明子进程确实处于 in-flight LLM 调用
    const deadline = Date.now() + 10_000;
    while (seen === 0 && Date.now() < deadline) await sleep(50);
    assert.ok(seen >= 1, '子进程应已发起 LLM 请求');
    await sleep(300); // 确保 fetch 完全挂起

    const exitCode = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-999);
      }, 15_000);
      child.once('exit', (code) => {
        clearTimeout(killer);
        resolve(code);
      });
      child.kill('SIGINT');
    });

    assert.equal(exitCode, 130, `退出码应为 130。子进程输出:\n${output}`);

    // 事件流：中断也要有完整的 turn.completed(aborted) 审计记录
    const sessDir = path.join(home, 'sessions');
    const id = fs.readdirSync(sessDir)[0]!;
    const events = fs
      .readFileSync(path.join(sessDir, id, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const lastTurn = events.filter((e) => e.type === 'turn.completed').at(-1);
    assert.ok(lastTurn, 'turn.completed 应落盘');
    assert.equal(lastTurn!.data.stopReason, 'aborted');
    assert.ok(events.some((e) => e.type === 'llm.request'), '中断前应已有 llm.request 事件');
  } finally {
    child.kill('SIGKILL');
    await server.close();
  }
}, { timeout: 40_000 });
