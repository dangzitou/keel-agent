import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { defaultConfig } from '../src/config.js';
import { SessionStore } from '../src/core/store.js';
import { fold } from '../src/core/fold.js';
import { runUserTurn } from '../src/core/loop.js';
import { forkSession } from '../src/commands.js';
import { MockProvider, setMockScript } from '../src/llm/provider.js';
import { executeToolCall } from '../src/tools/index.js';
import { QuietUi } from '../src/ui/render.js';
import { ChatResult } from '../src/llm/types.js';
import { startSseServer } from './helpers/sse-server.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-reliability-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  process.env.KEEL_HOME = path.join(root, 'home');
  process.env.KEEL_MOCK = '1';
  const cfg = defaultConfig();
  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive: false });
  t.after(() => { setMockScript(null); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, cfg, store, interactive: false, autoApprove: false, ui: new QuietUi(), userText: 'task' };
}
const call = (name: string, input: unknown) => ({ id: name, type: 'function' as const, function: { name, arguments: JSON.stringify(input) } });
const response = (name?: string, input?: unknown): ChatResult => ({ message: { content: name ? null : 'done', tool_calls: name ? [call(name, input)] : [] }, usage: { inputTokens: 1, outputTokens: 1 } });
async function until(fn: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < deadline, 'fixture timed out'); await sleep(10); }
}

test('resume: old evidence cannot certify external edits or changed checks in a new turn', async (t) => {
  for (const change of ['workspace', 'config', 'none']) {
    const ctx = fixture(t);
    ctx.cfg.verify.commands = ['test "$(cat value.txt)" = good'];
    setMockScript([() => response('write', { path: 'value.txt', content: 'good' }), () => response('verify', {}), () => response()]);
    assert.equal((await runUserTurn(ctx)).evidenceOk, true);
    if (change === 'workspace') fs.writeFileSync(path.join(ctx.cwd, 'value.txt'), 'bad');
    if (change === 'config') ctx.cfg.verify.commands = ['exit 7'];
    // Cover both reopening a session and another input on the same REPL store.
    const store = change === 'none' ? ctx.store : SessionStore.open(ctx.store.id);
    setMockScript([() => response('read', { path: 'value.txt' }), () => response()]);
    const stale = await runUserTurn({ ...ctx, store });
    assert.equal(stale.stopReason, 'unverified', change);
    assert.equal(stale.evidenceOk, false, change);
    assert.equal(store.readAll().filter((e) => e.type === 'verify.result' && e.data.ok).length, 1, 'preserve historical evidence');
    ctx.cfg.verify.commands = ['test "$(cat value.txt)" = good'];
    fs.writeFileSync(path.join(ctx.cwd, 'value.txt'), 'good');
    setMockScript([() => response('verify', {}), () => response()]);
    assert.equal((await runUserTurn({ ...ctx, store })).evidenceOk, true);
  }
});

test('files: read/edit/write reject special files without blocking or replacing them', async (t) => {
  const ctx = fixture(t);
  const fifo = path.join(ctx.cwd, 'input.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  fs.symlinkSync(fifo, path.join(ctx.cwd, 'alias'));
  const tools = new URL('../dist/tools/index.js', import.meta.url).href;
  for (const target of ['input.fifo', 'alias']) {
    for (const name of ['read', 'edit', 'write']) {
      const script = `import { executeToolCall } from ${JSON.stringify(tools)};
        const result = await executeToolCall(${JSON.stringify(call(name, { path: target, oldText: 'a', newText: 'b', content: 'c' }))},
          ${JSON.stringify({ cwd: ctx.cwd, cfg: ctx.cfg, interactive: false })});
        console.log(JSON.stringify(result));`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
      assert.equal(child.status, 0, `${name}: ${child.stderr || child.error}`);
      assert.equal(JSON.parse(child.stdout).ok, false, `${name}: ${target}`);
      assert.ok(fs.statSync(fifo).isFIFO(), 'never overwrite the special file');
    }
  }
  fs.writeFileSync(path.join(ctx.cwd, 'plain.txt'), 'a');
  fs.symlinkSync('plain.txt', path.join(ctx.cwd, 'plain-link'));
  assert.equal((await executeToolCall(call('read', { path: 'plain-link' }), ctx)).ok, true);
  assert.equal((await executeToolCall(call('edit', { path: 'plain-link', oldText: 'a', newText: 'b' }), ctx)).ok, true);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'plain.txt'), 'utf8'), 'b');
});

test('fork: historical success cannot certify the current workspace', async (t) => {
  const ctx = fixture(t);
  ctx.cfg.verify.commands = ['test "$(cat value.txt)" = good'];
  setMockScript([() => response('write', { path: 'value.txt', content: 'good' }), () => response('verify', {}), () => response()]);
  assert.equal((await runUserTurn(ctx)).evidenceOk, true);
  const verified = ctx.store.seq;
  setMockScript([() => response('write', { path: 'value.txt', content: 'bad' }), () => response()]);
  await runUserTurn(ctx);
  const child = forkSession(ctx.store.id, verified);
  setMockScript([() => response()]);
  const result = await runUserTurn({ ...ctx, store: child });
  assert.equal(result.stopReason, 'unverified');
  assert.equal(result.evidenceOk, false);
  assert.equal(SessionStore.open(child.id).readAll().filter((e) => e.type === 'verify.result' && e.data.ok).length, 1, 'keep historical evidence');
  setMockScript([() => response('write', { path: 'value.txt', content: 'good' }), () => response('verify', {}), () => response()]);
  assert.equal((await runUserTurn({ ...ctx, store: child })).evidenceOk, true);
});

test('bash: foreground completion reaps background work, including inherited pipes', async (t) => {
  const ctx = fixture(t);
  for (const redirection of ['', ' >/dev/null 2>&1']) {
    const result = await executeToolCall(call('bash', { command: `(sleep 0.2; touch orphan.txt)${redirection} &` }), ctx);
    assert.equal(result.ok, true, result.output);
    await sleep(250);
    assert.ok(!fs.existsSync(path.join(ctx.cwd, 'orphan.txt')), 'background work must not outlive the tool');
  }
});

test('grep: pathological regex is cancellable and bounded; normal searches still obey policy', async (t) => {
  const ctx = fixture(t);
  fs.writeFileSync(path.join(ctx.cwd, 'text.txt'), 'a'.repeat(40) + '!');
  fs.writeFileSync(path.join(ctx.cwd, '.env'), 'SECRET');
  // An external watchdog also bounds this test if grep regresses to blocking the main thread.
  const tools = new URL('../dist/tools/index.js', import.meta.url).href;
  const script = `import { executeToolCall } from ${JSON.stringify(tools)};
    const ctx=${JSON.stringify({ cwd: ctx.cwd, cfg: ctx.cfg, interactive: false })};
    const call=${JSON.stringify(call('grep', { pattern: '(a+)+$' }))};
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),100);
    const cancelled=await executeToolCall(call,{...ctx,signal:controller.signal});clearTimeout(timer);
    const timed=await executeToolCall(call,ctx);
    console.log(JSON.stringify({cancelled,timed}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL' });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const { cancelled, timed } = JSON.parse(child.stdout);
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.output, /中断/);
  assert.equal(timed.ok, false);
  assert.match(timed.output, /超时/);
  const found = await executeToolCall(call('grep', { pattern: 'a+!' }), ctx);
  assert.equal(found.ok, true, found.output);
  assert.match(found.output, /text.txt:1:/);
  assert.equal((await executeToolCall(call('grep', { pattern: 'SECRET' }), ctx)).output, '无匹配');
  assert.equal((await executeToolCall(call('grep', { pattern: '[' }), ctx)).ok, false);
});

test('store: interrupted lock reclamation is itself recoverable and keeps one writer', async (t) => {
  const ctx = fixture(t);
  const moduleURL = new URL('../dist/core/store.js', import.meta.url).href;
  const open = `import fs from 'node:fs'; import { SessionStore } from ${JSON.stringify(moduleURL)};
    const store = SessionStore.open(${JSON.stringify(ctx.store.id)});`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `${open} store.lock(); process.send('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await once(holder, 'message');
  const exit = once(holder, 'exit'); holder.kill('SIGKILL'); await exit;
  // Old releases stored only the PID and could leave this ownerless recovery directory.
  fs.writeFileSync(path.join(ctx.store.dir, 'writer.lock'), String(holder.pid));
  fs.mkdirSync(path.join(ctx.store.dir, 'writer-recovery.lock'));
  // Crash after creating the recovery claim, twice (also covers a crash recovering a recovery claim).
  for (let i = 0; i < 2; i++) {
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `${open}
      for (const method of ['mkdirSync','linkSync']) {
        const original=fs[method];
        fs[method]=function(...args) {const r=original.apply(this,args);
          if(String(args[method==='linkSync'?1:0]).includes('writer-recovery')) process.kill(process.pid,'SIGKILL'); return r;};
      }
      store.lock();`], { timeout: 3000 });
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr.toString());
  }
  const contenders = Array.from({ length: 3 }, () => spawn(process.execPath, ['--input-type=module', '-e', `${open}
    try {store.lock();process.send('won');setInterval(()=>{},1000);} catch {process.send('lost');}`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  try {
    const outcomes = await Promise.all(contenders.map(async (child) => (await once(child, 'message'))[0]));
    assert.equal(outcomes.filter((s) => s === 'won').length, 1);
  } finally {
    await Promise.all(contenders.map(async (child) => { if (child.exitCode === null && child.signalCode === null) {const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;} }));
  }
  ctx.store.append('user.message', { text: 'recovered' });
  assert.equal(SessionStore.open(ctx.store.id).readAll().at(-1)!.data.text, 'recovered');
});

test('CLI recovery: retry a provider failure, survive SIGKILL, and never repeat an unknown side effect', async (t) => {
  const ctx = fixture(t);
  const server = await startSseServer((i, _body, res) => {
    res.setHeader('content-type', 'application/json');
    if (i === 0) { res.statusCode = 503; res.end('{"error":"temporary outage"}'); return; }
    const result = i === 1 ? response('bash', { command: 'printf x >> counter.txt; sleep 0.5' })
      : i === 2 ? response('verify', {}) : response();
    res.end(JSON.stringify({ choices: [{ finish_reason: result.message.tool_calls.length ? 'tool_calls' : 'stop', message: result.message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), JSON.stringify({
    providers: { local: { baseURL: server.url, apiKeyEnv: 'LOCAL_TEST_KEY' } },
    llm: { stream: false, retries: 1 }, verify: { commands: ['test "$(cat counter.txt)" = x'] },
  }));
  const cli = new URL('../dist/index.js', import.meta.url).pathname;
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [cli, 'run', '--session', ctx.store.id, ...args], {
      env: { ...process.env, KEEL_MOCK: '0', KEEL_MODEL: 'local/test', KEEL_FAST_MODEL: 'local/test', LOCAL_TEST_KEY: 'local-test' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(child);
    return child;
  };
  const watchdog = setTimeout(() => children.forEach((child) => child.kill('SIGKILL')), 10000);
  try {
    const interrupted = launch(['apply change']);
    await until(() => fs.existsSync(path.join(ctx.cwd, 'counter.txt')));
    const exited = once(interrupted, 'exit'); interrupted.kill('SIGKILL'); await exited;
    await sleep(600); // The short-lived orphaned shell exits; SIGKILL cannot run agent cleanup.
    const recovered = launch(['recover and verify; do not repeat the previous command']);
    assert.equal((await once(recovered, 'exit'))[0], 0);
    const events = SessionStore.open(ctx.store.id).readAll();
    assert.equal(fs.readFileSync(path.join(ctx.cwd, 'counter.txt'), 'utf8'), 'x');
    assert.equal(events.filter((e) => e.type === 'tool.call' && e.data.tool === 'bash').length, 1);
    assert.ok(events.some((e) => e.type === 'tool.result' && e.data.tool === 'bash' && /结果未知/.test(e.data.output)));
    assert.equal(events.filter((e) => e.type === 'llm.retry').length, 1);
    assert.equal(events.at(-1)!.data.stopReason, 'done');
    assert.equal(events.at(-1)!.data.evidenceOk, true);
    assert.ok(!fs.existsSync(path.join(ctx.store.dir, 'writer.lock')));
  } finally { clearTimeout(watchdog); children.forEach((child) => child.kill('SIGKILL')); await server.close(); }
});

test('compaction: the middle and full tool arguments reach the summarizer', async (t) => {
  const ctx = fixture(t);
  ctx.store.append('user.message', { text: 'old log '.repeat(21000) });
  const marker = 'KEEP_THIS_DECISION';
  const args = JSON.stringify({ path: 'example.txt', content: 'x'.repeat(250) + marker });
  ctx.store.append('llm.response', { role: 'main', model: 'mock', content: null, toolCalls: [{ id: 'old', name: 'write', arguments: args }],
    usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, inHistory: true });
  ctx.store.append('tool.result', { toolCallId: 'old', tool: 'write', ok: true, output: 'written', durationMs: 1 });
  for (let i = 0; i < 6; i++) ctx.store.append('user.message', { text: `recent ${i}` });
  const original = MockProvider.prototype.chat;
  const inputs: string[] = [];
  MockProvider.prototype.chat = async function (params) {
    if (params.messages[0]!.content!.includes('摘要器')) {
      const input = params.messages[1]!.content!; inputs.push(input);
      return { ...response(), message: { content: input.includes(marker) ? marker : 'summary', tool_calls: [] } };
    }
    return response();
  };
  try {
    await runUserTurn(ctx);
    assert.ok(inputs.join('').includes(marker), 'the middle must not disappear before summarization');
    assert.ok(inputs.every((s) => s.length <= 60000));
    assert.ok(JSON.stringify(fold(ctx.store.readAll()).messages).includes(marker));
  } finally { MockProvider.prototype.chat = original; }
});

test('compaction: partial failure or budget exhaustion preserves the old view and accounts for calls', async (t) => {
  const original = MockProvider.prototype.chat;
  try {
    for (const mode of ['error', 'budget']) {
      const ctx = fixture(t);
      ctx.store.append('user.message', { text: 'OLD_CONTEXT'.repeat(16000) });
      for (let i = 0; i < 8; i++) ctx.store.append('user.message', { text: `recent ${i}` });
      ctx.cfg.budget.maxTokensPerSession = mode === 'budget' ? 2 : 100;
      let calls = 0;
      MockProvider.prototype.chat = async () => {
        if (++calls === 2) throw new Error('summary failed');
        return response();
      };
      const result = await runUserTurn(ctx);
      assert.equal(result.stopReason, mode);
      assert.equal(calls, mode === 'budget' ? 1 : 2);
      const events = ctx.store.readAll();
      assert.equal(events.filter((e) => e.type === 'context.compacted').length, 0);
      assert.match(fold(events).messages[0]!.content!, /^OLD_CONTEXT/);
      assert.equal(fold(events).spend.inputTokens + fold(events).spend.outputTokens, 2);
    }
  } finally { MockProvider.prototype.chat = original; }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`REPL: ${signal} reaches the active tool and persists cancellation`, async (t) => {
    const ctx = fixture(t);
    const server = await startSseServer((_i, _body, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call('bash', { command: 'touch started; (sleep 0.5; touch orphan.txt) & wait' })] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), JSON.stringify({ providers: { local: { baseURL: server.url, apiKeyEnv: 'LOCAL_TEST_KEY' } }, llm: { stream: false } }));
    const cli = new URL('../dist/index.js', import.meta.url);
    const child = spawn(process.execPath, [cli.pathname, '--cwd', ctx.cwd], { env: { ...process.env, KEEL_MOCK: '0', KEEL_MODEL: 'local/test', KEEL_FAST_MODEL: 'local/test', LOCAL_TEST_KEY: 'local-test' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      child.stdin.write('task\n');
      await until(() => fs.existsSync(path.join(ctx.cwd, 'started')));
      const exited = once(child, 'exit'); child.kill(signal);
      // SIGINT interrupts the current turn and leaves REPL available; EOF then exits.
      if (signal === 'SIGINT') child.stdin.end();
      const [code] = await exited;
      assert.equal(code, signal === 'SIGTERM' ? 130 : 0);
      const store = SessionStore.open(SessionStore.list()[0]!.id);
      assert.equal(store.readAll().at(-1)!.data.stopReason, 'aborted');
      assert.ok(!fs.existsSync(path.join(store.dir, 'writer.lock')));
      await sleep(550);
      assert.ok(!fs.existsSync(path.join(ctx.cwd, 'orphan.txt')));
    } finally { clearTimeout(timeout); child.kill('SIGKILL'); await server.close(); }
  });
}
