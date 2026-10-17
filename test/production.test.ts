import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, loadConfig, validateConfig } from '../src/config.js';
import { SessionStore } from '../src/core/store.js';
import { fold } from '../src/core/fold.js';
import { runUserTurn } from '../src/core/loop.js';
import { checkPolicy } from '../src/policy/policy.js';
import { executeToolCall } from '../src/tools/index.js';
import { setMockScript } from '../src/llm/provider.js';
import { QuietUi } from '../src/ui/render.js';
import { ChatResult } from '../src/llm/types.js';
import { ResponsesProvider } from '../src/llm/responses.js';
import { AnthropicProvider, toAnthropicBody } from '../src/llm/anthropic.js';
import { OpenAICompatProvider } from '../src/llm/provider.js';
import { sseDataChunks, httpError } from '../src/llm/http.js';
import { sleep } from '../src/llm/retry.js';
import { costFor, hasKnownPrice } from '../src/llm/cost.js';
import { forkSession } from '../src/commands.js';
import { startSseServer, sendSse, sseChunk } from './helpers/sse-server.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-production-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  process.env.KEEL_HOME = path.join(root, 'home');
  const cfg = defaultConfig();
  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive: false });
  return { root, cwd, cfg, store, interactive: false };
}

function call(name: string, args: unknown, id = name) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
}

function response(name?: string, args?: unknown): ChatResult {
  return { message: { content: name ? null : 'done', tool_calls: name ? [call(name, args)] : [] }, usage: { inputTokens: 100, outputTokens: 10 } };
}

test('security: grep/glob omit denied paths and symlinks cannot escape or alias secrets', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.cwd, '.env'), 'SECRET_SENTINEL=secret');
  fs.writeFileSync(path.join(ctx.cwd, 'public.txt'), 'public');
  fs.symlinkSync(path.join(ctx.cwd, '.env'), path.join(ctx.cwd, 'alias.txt'));
  fs.symlinkSync(ctx.root, path.join(ctx.cwd, 'outside'));
  fs.symlinkSync(path.join(ctx.root, 'not-created.txt'), path.join(ctx.cwd, 'dangling.txt'));
  assert.equal(checkPolicy(ctx.cfg.policy, { tool: 'write', input: { path: 'dangling.txt' }, cwd: ctx.cwd }).decision, 'deny');
  for (const tool of ['read', 'write', 'edit', 'grep', 'glob']) {
    assert.equal(checkPolicy(ctx.cfg.policy, { tool, input: { path: 'outside/new/file' }, cwd: ctx.cwd }).decision, 'deny', tool);
  }
  assert.equal(checkPolicy(ctx.cfg.policy, { tool: 'read', input: { path: 'alias.txt' }, cwd: ctx.cwd }).decision, 'deny');
  const grep = await executeToolCall(call('grep', { pattern: 'SECRET_SENTINEL' }), ctx);
  assert.equal(grep.ok, true);
  assert.ok(!grep.output.includes('SECRET_SENTINEL'), grep.output);
  const glob = await executeToolCall(call('glob', { pattern: '**/*' }), ctx);
  assert.ok(!glob.output.includes('.env'), glob.output);
});

test('security: verify obeys deny/approval/readOnly policies before any command runs', async () => {
  process.env.KEEL_MOCK = '1';
  for (const mode of ['deny', 'approve', 'readOnly']) {
    const ctx = fixture();
    const command = 'touch bypass.txt';
    if (mode === 'deny') ctx.cfg.policy.bashDeny.push(command);
    if (mode === 'approve') ctx.cfg.policy.bashApprove.push(command);
    if (mode === 'readOnly') ctx.cfg.policy.readOnly = true;
    setMockScript([() => response('verify', { commands: [command] }), () => response()]);
    await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'verify', autoApprove: false });
    assert.ok(!fs.existsSync(path.join(ctx.cwd, 'bypass.txt')), mode);
  }
});

test('contract: configured failing checks cannot be replaced with true', async () => {
  const ctx = fixture();
  ctx.cfg.verify.commands = ['exit 7'];
  const result = await executeToolCall(call('verify', { commands: ['true'] }), ctx);
  assert.equal(result.ok, false);
  assert.equal(fold(ctx.store.readAll()).lastVerifyOkSeq, 0);
  fs.writeFileSync(path.join(ctx.cwd, 'value.txt'), 'good');
  ctx.cfg.verify.commands = ["test \"$(cat value.txt)\" = good"];
  const stale = await executeToolCall(call('verify', { commands: [...ctx.cfg.verify.commands, 'printf bad > value.txt'] }), ctx);
  assert.equal(stale.ok, false, 'mandatory checks run after model-supplied commands');
});

test('contract: failed bash can mutate files and still requires verification', async () => {
  const ctx = fixture();
  process.env.KEEL_MOCK = '1';
  setMockScript([() => response('bash', { command: 'touch modified.txt; exit 1' }), () => response()]);
  const summary = await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'modify', autoApprove: false });
  assert.equal(summary.stopReason, 'unverified');
  assert.equal(summary.evidenceOk, false);
});

test('recovery: interrupted tool batches get results without re-executing side effects', async () => {
  const ctx = fixture();
  process.env.KEEL_MOCK = '1';
  ctx.store.append('llm.response', { role: 'main', model: 'deepseek-chat', content: null,
    toolCalls: [{ id: 'pending', name: 'write', arguments: '{"path":"never.txt","content":"x"}' }],
    usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, latencyMs: 1, inHistory: true });
  setMockScript([() => response()]);
  await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'continue', autoApprove: false });
  const messages = fold(ctx.store.readAll()).messages;
  const assistant = messages.findIndex((m) => m.tool_calls?.[0]?.id === 'pending');
  assert.equal(messages[assistant + 1]?.role, 'tool');
  assert.equal(messages[assistant + 1]?.tool_call_id, 'pending');
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'never.txt')));
});

test('input: non-object or wrongly typed arguments never crash or write undefined paths', async () => {
  const ctx = fixture();
  process.env.KEEL_MOCK = '1';
  for (const args of [null, [], { content: 'x' }, { path: 123, content: 'x' }]) {
    setMockScript([() => response('write', args), () => response()]);
    const summary = await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'invalid', autoApprove: false });
    assert.equal(summary.stopReason, 'done');
  }
  assert.deepEqual(fs.readdirSync(ctx.cwd), []);
});

test('budget: resumed sessions already over budget issue no new LLM request', async () => {
  const ctx = fixture();
  ctx.cfg.budget.maxUsdPerSession = 0.01;
  ctx.store.append('llm.response', { role: 'main', model: 'deepseek-chat', content: 'old', toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1, latencyMs: 1, inHistory: true });
  process.env.KEEL_MOCK = '1';
  let requests = 0;
  setMockScript([() => { requests++; return response(); }]);
  const summary = await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'continue', autoApprove: false });
  assert.equal(summary.stopReason, 'budget');
  assert.equal(requests, 0);
});

test('stream: Responses failure/incomplete/truncated output never becomes done', async () => {
  for (const type of ['response.failed', 'response.incomplete', 'error', 'truncated']) {
    const server = await startSseServer((_i, _body, res) => sendSse(res, [
      sseChunk({ type: 'response.output_text.delta', delta: 'partial' }),
      ...(type === 'truncated' ? [] : [sseChunk({ type, response: { error: { message: 'failed' } }, error: { message: 'failed' } })]),
    ]));
    try {
      await assert.rejects(new ResponsesProvider(server.url, 'test').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }));
    } finally { await server.close(); }
  }
});

test('store: torn tail is recoverable, interior corruption is never silently dropped', () => {
  const ctx = fixture();
  ctx.store.append('user.message', { text: 'first' });
  const file = path.join(ctx.store.dir, 'events.jsonl');
  fs.appendFileSync(file, '{"seq":2');
  const resumed = SessionStore.open(ctx.store.id);
  resumed.append('user.message', { text: 'second' });
  assert.equal(SessionStore.open(ctx.store.id).readAll().length, 2);
  fs.appendFileSync(file, 'CORRUPT\n');
  assert.throws(() => SessionStore.open(ctx.store.id), /损坏|corrupt/i);
});

test('store: concurrent process is rejected and SIGKILL releases a stale writer on resume', async () => {
  const ctx = fixture();
  const moduleURL = new URL('../dist/core/store.js', import.meta.url).href;
  const script = `import { SessionStore } from ${JSON.stringify(moduleURL)};
    const store = SessionStore.open(${JSON.stringify(ctx.store.id)});
    store.lock(); store.append('user.message', { text: 'child' });
    process.send('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('child exited early'))); });
    assert.throws(() => ctx.store.append('user.message', { text: 'blocked' }), /锁定|执行中/);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  ctx.store.append('user.message', { text: 'resumed' });
  const events = SessionStore.open(ctx.store.id).readAll();
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.deepEqual(events.map((e) => e.data.text), ['child', 'resumed']);
  assert.equal(fs.statSync(path.join(ctx.store.dir, 'events.jsonl')).mode & 0o777, 0o600);
  assert.throws(() => SessionStore.open('../escape'), /非法/);
  assert.throws(() => SessionStore.create({ cwd: ctx.cwd, model: 'mock', interactive: false, id: ctx.store.id }), /EEXIST/);
  for (const seq of [-1, 0, 9999, 1.2, NaN]) assert.throws(() => forkSession(ctx.store.id, seq), /范围/);
});

test('contract: a later failed verification invalidates earlier success; successful turns report true', async () => {
  const ctx = fixture();
  process.env.KEEL_MOCK = '1';
  setMockScript([() => response('write', { path: 'a.txt', content: 'x' }), () => response('verify', { commands: ['true'] }), () => response()]);
  const summary = await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'write', autoApprove: false });
  assert.equal(summary.evidenceOk, true);
  await executeToolCall(call('verify', { commands: ['exit 1'] }), ctx);
  assert.ok(fold(ctx.store.readAll()).lastFileModSeq > fold(ctx.store.readAll()).lastVerifyOkSeq);
});

test('budget: unknown model prices still enforce tokens and custom prices are attributable', async () => {
  const ctx = fixture();
  ctx.cfg.router.main = ctx.cfg.router.fast = 'stepfun/step-unpriced-test';
  ctx.cfg.budget.maxTokensPerSession = 100;
  process.env.KEEL_MOCK = '1';
  setMockScript([() => response('write', { path: 'never.txt', content: 'x' })]);
  const summary = await runUserTurn({ ...ctx, ui: new QuietUi(), userText: 'budget', autoApprove: false });
  assert.equal(summary.stopReason, 'budget');
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'never.txt')));
  assert.equal(fold(ctx.store.readAll()).spend.unpricedCalls, 1);
  const pricing = { 'stepfun/step-unpriced-test': { input: 1, output: 2 } };
  assert.equal(costFor('stepfun/step-unpriced-test', 1_000_000, 1_000_000, pricing), 3);
  assert.equal(hasKnownPrice('stepfun/step-unpriced-test', pricing), true);
});

test('input: configuration rejects malformed values and preserves explicit main/fast routes', () => {
  const ctx = fixture();
  for (const change of [
    { maxTurns: 0 }, { llm: { retries: -1 } }, { policy: { readOnly: 'false' } },
    { verify: { commands: [''] } }, { context: { keepRecentMessages: 0 } },
    { providers: { bad: { baseURL: 'file:///tmp', apiKeyEnv: 'KEY' } } },
  ]) {
    fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), JSON.stringify(change));
    assert.throws(() => loadConfig(ctx.cwd), /不合法/);
  }
  assert.throws(() => validateConfig({ ...ctx.cfg, pricing: { bad: { input: -1, output: 1 } } }), /不合法/);
  const saved = { ...process.env };
  try {
    delete process.env.KEEL_MODEL;
    delete process.env.KEEL_FAST_MODEL;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.STEPFUN_API_KEY = 'test';
    const router = { main: 'deepseek/deepseek-chat', fast: 'qwen/qwen-plus' };
    fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), JSON.stringify({ router }));
    assert.deepEqual(loadConfig(ctx.cwd).cfg.router, router);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('tools: edit preserves literal replacement tokens; bash cannot read harness credentials', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'old old');
  const literal = '$& $` $\' $$';
  assert.equal((await executeToolCall(call('edit', { path: 'a.txt', oldText: 'old', newText: literal, replaceAll: true }), ctx)).ok, true);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'a.txt'), 'utf8'), `${literal} ${literal}`);
  const saved = process.env.STEPFUN_API_KEY;
  process.env.STEPFUN_API_KEY = 'credential-sentinel';
  try {
    const result = await executeToolCall(call('bash', { command: 'printenv STEPFUN_API_KEY' }), ctx);
    assert.ok(!result.output.includes('credential-sentinel'));
  } finally { if (saved === undefined) delete process.env.STEPFUN_API_KEY; else process.env.STEPFUN_API_KEY = saved; }
});

test('tools: partial I/O failure preserves original files; atomic edits preserve symlinks and mode', async () => {
  const ctx = fixture();
  const file = path.join(ctx.cwd, 'script.sh');
  fs.writeFileSync(file, 'original', { mode: 0o755 });
  fs.symlinkSync(file, path.join(ctx.cwd, 'alias.sh'));
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = ((target: any, ...args: any[]) => {
      if (typeof target === 'number') { original(target, 'partial'); throw new Error('simulated disk failure'); }
      return (original as any)(target, ...args);
    }) as typeof fs.writeFileSync;
    assert.equal((await executeToolCall(call('edit', { path: 'script.sh', oldText: 'original', newText: 'changed' }), ctx)).ok, false);
  } finally { fs.writeFileSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(ctx.cwd).sort(), ['alias.sh', 'script.sh']);
  assert.equal((await executeToolCall(call('edit', { path: 'alias.sh', oldText: 'original', newText: 'changed' }), ctx)).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed');
  assert.ok(fs.lstatSync(path.join(ctx.cwd, 'alias.sh')).isSymbolicLink());
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  const target = path.join(ctx.cwd, 'new.sh');
  fs.symlinkSync(target, path.join(ctx.cwd, 'new-alias.sh'));
  assert.equal((await executeToolCall(call('write', { path: 'new-alias.sh', content: 'new' }), ctx)).ok, true);
  assert.ok(fs.lstatSync(path.join(ctx.cwd, 'new-alias.sh')).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('stream: all protocols reject partial or error responses; Anthropic merges valid text blocks', async () => {
  const body = toAnthropicBody({ model: 'm', messages: [
    { role: 'user', content: 'hello' }, { role: 'user', content: 'again' },
  ] }, false) as any;
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hello' }, { type: 'text', text: 'again' }]);
  for (const [Provider, data] of [
    [OpenAICompatProvider, { choices: [{ delta: { content: 'partial' } }] }],
    [AnthropicProvider, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }],
  ] as const) {
    const server = await startSseServer((_i, _body, res) => sendSse(res, [sseChunk(data)]));
    try { await assert.rejects(new Provider(server.url, 'test').chat({ model: 'm', messages: [], stream: true }), /截断/); }
    finally { await server.close(); }
  }
});

test('stream: SSE multiline/CRLF/final frame, abortable sleep and retry-after work', async () => {
  const res = new Response('data: {\r\ndata: "hello": "你好"}\r\n\r\ndata: [DONE]');
  const payloads: string[] = [];
  for await (const payload of sseDataChunks(res)) payloads.push(payload);
  assert.deepEqual(payloads, ['{\n"hello": "你好"}', '[DONE]']);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(sleep(1000, abort.signal), /aborted/);
  const retry = httpError(429, 'rate limited', new Date(Date.now() + 5000).toUTCString());
  assert.ok(retry.retryAfterMs! > 0 && retry.retryAfterMs! <= 5000);
});

test('CLI: noninteractive approvals fail closed, --yes works, --session resumes project config', () => {
  const ctx = fixture();
  const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const env = { ...process.env, KEEL_MOCK: '1', KEEL_MODEL: 'deepseek/deepseek-chat' };
  const command = 'touch approved.txt';
  fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), JSON.stringify({ verify: { commands: [command] }, policy: { bashApprove: [command] } }));
  const rejected = spawnSync(process.execPath, [cli, 'run', '--cwd', ctx.cwd, 'write'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(rejected.status, 3, rejected.stdout + rejected.stderr);
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'approved.txt')));
  const accepted = spawnSync(process.execPath, [cli, 'run', '--cwd', ctx.cwd, '--yes', 'write'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.ok(fs.existsSync(path.join(ctx.cwd, 'approved.txt')));
  const id = SessionStore.list()[0]!.id;
  const sessionCount = SessionStore.list().length;
  const resumed = spawnSync(process.execPath, [cli, 'run', '--session', id, '--yes', 'continue'], { env, cwd: ctx.root, encoding: 'utf8', timeout: 5000 });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(fold(SessionStore.open(id).readAll()).turns, 2);
  assert.equal(SessionStore.list().length, sessionCount, 'resume must not create a new session');
  for (const args of [['run', '--typo'], ['fork', id, '--at', '1.2'], ['run', '--model']]) {
    assert.equal(spawnSync(process.execPath, [cli, ...args], { env, timeout: 5000 }).status, 2);
  }
});

test('REPL: EOF drains queued turns and queued slash commands remain commands', () => {
  const ctx = fixture();
  const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--cwd', ctx.cwd], {
    env: { ...process.env, KEEL_MOCK: '1', KEEL_MODEL: 'deepseek/deepseek-chat' },
    input: 'first\n/plan\nsecond\n', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = SessionStore.open(SessionStore.list()[0]!.id).readAll();
  assert.deepEqual(events.filter((e) => e.type === 'user.message').map((e) => e.data.text), ['first', 'second']);
  assert.equal(fold(events).turns, 2);
  assert.ok(result.stdout.includes('当前没有计划'));
});

test('abort: last-iteration bash interruption kills descendants and persists aborted', async () => {
  const ctx = fixture();
  const controller = new AbortController();
  process.env.KEEL_MOCK = '1';
  setMockScript([() => response('bash', { command: '(sleep 0.3; touch orphan.txt) & wait' })]);
  const timer = setTimeout(() => controller.abort(), 100);
  let result;
  try {
    result = await runUserTurn({ ...ctx, cfg: { ...ctx.cfg, maxTurns: 1 }, ui: new QuietUi(), userText: 'abort', autoApprove: false, signal: controller.signal });
  } finally { clearTimeout(timer); }
  assert.equal(result.stopReason, 'aborted');
  assert.equal(ctx.store.readAll().at(-1)!.data.stopReason, 'aborted');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'orphan.txt')));
});

test('REPL: approval consumes the answer once, and waiting for approval can be aborted', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), JSON.stringify({
    verify: { commands: ['touch approved.txt'] }, policy: { bashApprove: ['touch approved.txt'] },
  }));
  const repl = new URL('../dist/repl.js', import.meta.url).href;
  const script = `import { startRepl } from ${JSON.stringify(repl)};
    Object.defineProperty(process.stdin, 'isTTY', {value:true});
    await startRepl({cwd:${JSON.stringify(ctx.cwd)}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, KEEL_MOCK: '1', KEEL_MODEL: 'deepseek/deepseek-chat' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let answered = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!answered && output.includes('[y/N]')) { answered = true; child.stdin.write('y\n'); }
      if (output.includes(' · done · ')) child.stdin.end();
    });
    child.stdin.write('task\n');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, output);
    const events = SessionStore.open(SessionStore.list()[0]!.id).readAll();
    assert.deepEqual(events.filter((e) => e.type === 'user.message').map((e) => e.data.text), ['task']);
    assert.ok(fs.existsSync(path.join(ctx.cwd, 'approved.txt')));
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }

  const ui = new URL('../dist/ui/render.js', import.meta.url).href;
  const abortScript = `import { TerminalUi } from ${JSON.stringify(ui)};
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const allowed = await new TerminalUi().approve('waiting', controller.signal);
    if (allowed) process.exitCode = 1;`;
  const aborted = spawnSync(process.execPath, ['--input-type=module', '-e', abortScript], { input: '', encoding: 'utf8', timeout: 1000 });
  assert.equal(aborted.status, 0, aborted.stdout + aborted.stderr);
});
