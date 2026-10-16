// Opt-in real-model evaluation. Credentials come only from the caller's environment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../dist/core/store.js';
import { fold } from '../dist/core/fold.js';
import { forkSession } from '../dist/commands.js';

assert.ok(process.env.STEPFUN_API_KEY, 'Set STEPFUN_API_KEY before running this opt-in evaluation');
assert.notEqual(process.env.KEEL_MOCK, '1', 'Real evaluation cannot use mock mode');
const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-live-stepfun-'));
process.env.KEEL_HOME = path.join(root, 'home');
const env = { ...process.env, KEEL_MODEL: 'stepfun/step-5-preview', KEEL_FAST_MODEL: 'stepfun/step-5-preview' };
const checks = [];
// Preserve partial results too; a failed sample must not disappear from the evidence.
process.on('exit', (exitCode) => {
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ timestamp: new Date().toISOString(),
    model: env.KEEL_MODEL, root, exitCode, checks }, null, 2), { mode: 0o600 });
});

async function run(args, label) {
  const log = path.join(root, `${label}.log`);
  const fd = fs.openSync(log, 'w', 0o600);
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', fd, fd] });
  let hardStop;
  const timer = setTimeout(() => { child.kill('SIGINT'); hardStop = setTimeout(() => child.kill('SIGKILL'), 5000); }, 240_000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (code !== 0) checks.push({ case: label, exitCode: code, log, status: 'failed' });
    assert.equal(code, 0, `${label} CLI failed; inspect ${log}`);
  } finally { clearTimeout(timer); clearTimeout(hardStop); fs.closeSync(fd); }
}

for (const [offset, stream] of [true, false, true].entries()) {
  const index = offset + 1;
  const cwd = path.join(root, `case-${index}`);
  fs.mkdirSync(cwd);
  const tests = `import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(20, 0, 10), 10);
assert.throws(() => clamp(NaN, 0, 10), TypeError);
assert.throws(() => clamp(1, 10, 0), RangeError);
console.log('clamp checks passed');
`;
  fs.writeFileSync(path.join(cwd, 'clamp.mjs'), 'export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }\n');
  fs.writeFileSync(path.join(cwd, 'check.mjs'), tests);
  const config = {
    router: { main: env.KEEL_MODEL, fast: env.KEEL_FAST_MODEL },
    verify: { commands: ['node check.mjs'] },
    llm: { stream, timeoutMs: 180_000, retries: 1 }, maxTurns: 12,
    budget: { maxUsdPerSession: 1, maxTokensPerSession: 150_000 },
  };
  fs.writeFileSync(path.join(cwd, '.keel.json'), JSON.stringify(config));
  const started = Date.now();
  console.log(`case ${index}: stream=${stream}; ${cwd}`);
  await run(['run', '--cwd', cwd, '修复 clamp.mjs：任一参数非有限 number 时抛 TypeError，min > max 抛 RangeError，其他情况返回钳制值。先 read，使用 plan 管理步骤，保留 check.mjs 和 .keel.json 不变，完成前 verify 配置的检查。'], `case-${index}`);
  const meta = SessionStore.list().find((m) => m.cwd === cwd);
  assert.ok(meta);
  const store = SessionStore.open(meta.id);
  const state = fold(store.readAll());
  assert.equal(fs.readFileSync(path.join(cwd, 'check.mjs'), 'utf8'), tests, 'Tests must remain unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.keel.json'), 'utf8')), config);
  const { clamp } = await import(path.join(cwd, 'clamp.mjs'));
  for (const bad of [NaN, Infinity, -Infinity, '1', undefined, null]) {
    assert.throws(() => clamp(bad, 0, 10), TypeError);
    assert.throws(() => clamp(1, bad, 10), TypeError);
    assert.throws(() => clamp(1, 0, bad), TypeError);
  }
  assert.throws(() => clamp(1, 10, 0), RangeError);
  assert.equal(clamp(4, 0, 10), 4);
  assert.ok(state.lastVerifyOkSeq > state.lastFileModSeq);
  assert.ok(state.plan?.every((step) => step.status === 'done'));
  const completed = store.readAll().filter((e) => e.type === 'turn.completed').at(-1);
  assert.equal(completed.data.evidenceOk, true);
  for (const event of store.readAll().filter((e) => e.type === 'verify.result' && e.data.ok)) {
    assert.ok(fs.existsSync(path.join(store.evidenceDir(), `${event.seq}.json`)));
  }
  checks.push({ case: index, stream, session: store.id, stop: completed.data.stopReason,
    evidenceOk: completed.data.evidenceOk, calls: Object.values(state.spend.byModel).reduce((n, s) => n + s.calls, 0),
    inputTokens: state.spend.inputTokens, outputTokens: state.spend.outputTokens,
    unpricedCalls: state.spend.unpricedCalls, latencyMs: Date.now() - started });
  console.log(JSON.stringify(checks.at(-1)));
  if (index === 1) {
    // Change the workspace outside the session: old evidence must not survive resume.
    fs.writeFileSync(path.join(cwd, 'clamp.mjs'), 'export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }\n');
    await run(['run', '--session', store.id, '文件在会话外被改动了。重新读取 clamp.mjs，恢复之前要求的参数校验，保留测试和配置不变，重新 verify 后完成。'], 'resume');
    const resumed = SessionStore.open(store.id).readAll();
    assert.equal(fold(resumed).turns, 2);
    assert.ok(resumed.some((e) => e.seq > completed.seq && e.type === 'verify.invalidated'));
    assert.ok(resumed.some((e) => e.seq > completed.seq && e.type === 'verify.result' && e.data.ok));
    assert.equal(resumed.at(-1).data.evidenceOk, true);
    const repaired = await import(`${path.join(cwd, 'clamp.mjs')}?resumed=1`);
    for (const bad of [NaN, Infinity, -Infinity, '1', undefined, null]) {
      assert.throws(() => repaired.clamp(bad, 0, 10), TypeError);
      assert.throws(() => repaired.clamp(1, bad, 10), TypeError);
      assert.throws(() => repaired.clamp(1, 0, bad), TypeError);
    }
    assert.throws(() => repaired.clamp(1, 10, 0), RangeError);
    assert.equal(fs.readFileSync(path.join(cwd, 'check.mjs'), 'utf8'), tests);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.keel.json'), 'utf8')), config);
    const prefixAt = store.readAll().find((e) => e.type === 'llm.response' && e.data.toolCalls?.length)?.seq;
    assert.ok(prefixAt);
    const child = forkSession(store.id, prefixAt);
    await run(['run', '--session', child.id, '这是从工具执行前分叉的会话，当前工作目录已经有修复。用 read 检查，再 verify 现有配置，不要重新写文件，最后完成。'], 'fork');
    const events = SessionStore.open(child.id).readAll();
    assert.equal(events.at(-1).data.stopReason, 'done');
    assert.equal(events.filter((e) => e.type === 'tool.call' && ['write', 'edit'].includes(e.data.tool)).length, 0);
    checks.push({ case: 'resume-and-fork', parent: store.id, child: child.id, stop: 'done' });
    console.log('resume + fork passed');
  }
}

console.log(`PASS: evidence saved at ${root}/results.json`);
