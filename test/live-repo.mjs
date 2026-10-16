// Opt-in evaluation against an isolated copy of this real repository with two seeded regressions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../dist/core/store.js';
import { fold } from '../dist/core/fold.js';

assert.ok(process.env.STEPFUN_API_KEY, 'Set STEPFUN_API_KEY');
assert.notEqual(process.env.KEEL_MOCK, '1');
const source = fileURLToPath(new URL('..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-live-repo-'));
let report = { timestamp: new Date().toISOString(), root, status: 'incomplete' };
process.on('exit', (exitCode) => {
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ ...report, exitCode }, null, 2), { mode: 0o600 });
});
const cwd = path.join(root, 'workspace');
fs.mkdirSync(cwd);
for (const name of ['src', 'test', 'node_modules', 'package.json', 'package-lock.json', 'tsconfig.json']) {
  fs.cpSync(path.join(source, name), path.join(cwd, name), { recursive: true });
}
const allowed = new Set(['src/core/loop.ts', 'src/tools/builtin.ts']);
const replace = (name, from, to) => {
  const file = path.join(cwd, name);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split(from).length, 2, `fixture must match exactly once: ${name}`);
  fs.writeFileSync(file, text.replace(from, to));
};
replace('src/core/loop.ts', "  if (state.lastVerifyOkSeq) store.append('verify.invalidated', { reason: '新一轮任务开始，工作目录或验证配置可能变化，需重新验证。' });\n", '');
replace('src/tools/builtin.ts', 'fs.constants.O_RDONLY | fs.constants.O_NONBLOCK', 'fs.constants.O_RDONLY');
replace('src/tools/builtin.ts', "    if (!stat.isFile()) throw new Error('只支持普通文件');\n", '');
replace('src/tools/builtin.ts', "  if (exists && !fs.statSync(target).isFile()) throw new Error('只支持普通文件');\n", '');
process.env.KEEL_HOME = path.join(root, 'home');
const config = { router: { main: 'stepfun/step-5-preview', fast: 'stepfun/step-5-preview' },
  verify: { commands: ['npm test'] }, llm: { stream: true, timeoutMs: 120_000, retries: 1 },
  maxTurns: 24, budget: { maxUsdPerSession: 2, maxTokensPerSession: 300_000 } };
fs.writeFileSync(path.join(cwd, '.keel.json'), JSON.stringify(config));
const snapshot = (dir, prefix = '') => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (['node_modules', 'dist'].includes(entry.name)) return [];
  const name = prefix + entry.name;
  return entry.isDirectory() ? Object.entries(snapshot(path.join(dir, entry.name), name + '/'))
    : [[name, createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex')]];
}));
const before = snapshot(cwd);
const run = (command, args, label, env, timeout = 90_000) => {
  const fd = fs.openSync(path.join(root, `${label}.log`), 'w', 0o600);
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], timeout, killSignal: 'SIGKILL' });
    assert.ok(!result.error, `${label}: ${result.error}`);
    return result.status;
  } finally { fs.closeSync(fd); }
};
// The independent verifier never receives provider credentials.
// The project config selects the real model; do not leak CLI overrides into the project's tests.
const agentEnv = { ...process.env, KEEL_MOCK: '0' };
delete agentEnv.KEEL_MODEL;
delete agentEnv.KEEL_FAST_MODEL;
const checkEnv = { ...agentEnv };
for (const name of Object.keys(checkEnv)) if (/API_KEY|TOKEN|SECRET/.test(name)) delete checkEnv[name];
assert.equal(run('npm', ['run', 'build'], 'baseline-build', checkEnv), 0);
assert.equal(run(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=resume: old evidence|files: read/edit/write', 'test/reliability.test.ts'], 'baseline-regressions', checkEnv), 1);
assert.match(fs.readFileSync(path.join(root, 'baseline-regressions.log'), 'utf8'), /# fail 2\b/);
console.log(`Repository fixture: ${cwd}; baseline regressions reproduced`);
const started = Date.now();
const status = run(process.execPath, [path.join(source, 'dist/index.js'), 'run', '--cwd', cwd,
  '修复当前仓库的两个可靠性回归：续跑不能沿用旧验证证据；read/edit/write 必须安全拒绝特殊文件，不能挂起或覆盖 FIFO。检查现有实现和失败测试，保持零运行时依赖。只修改 src/core/loop.ts 和 src/tools/builtin.ts，不修改测试、配置或依赖。先 plan，完成后 verify 跑通 npm test。'],
  'agent', agentEnv, 600_000);
const elapsedMs = Date.now() - started;
assert.equal(status, 0, `agent failed; inspect ${root}/agent.log`);
const after = snapshot(cwd);
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]);
assert.ok(changed.length > 0 && changed.every((name) => allowed.has(name)), `unexpected changes: ${changed}`);
assert.equal(run('npm', ['test'], 'independent-tests', checkEnv), 0, 'external acceptance failed');
const store = SessionStore.open(SessionStore.list()[0].id);
const events = store.readAll();
const completed = events.at(-1);
assert.equal(completed.data.stopReason, 'done');
assert.equal(completed.data.evidenceOk, true);
const state = fold(events);
report = { timestamp: new Date().toISOString(), root, status: 'passed', session: store.id, model: config.router.main,
  stop: completed.data.stopReason, evidenceOk: completed.data.evidenceOk, changed, elapsedMs,
  inputTokens: state.spend.inputTokens, outputTokens: state.spend.outputTokens,
  calls: Object.values(state.spend.byModel).reduce((sum, model) => sum + model.calls, 0),
  baseline: 'two seeded regressions fail', acceptance: 'unmodified full test suite passes outside agent',
  scope: 'one controlled task in a real repository copy; not a production benchmark or OS sandbox' };
console.log(JSON.stringify(report, null, 2));
