import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, validateConfig, KeelConfig } from '../src/config.js';
import { SessionStore } from '../src/core/store.js';
import { fold } from '../src/core/fold.js';
import { runUserTurn } from '../src/core/loop.js';
import { checkPolicy } from '../src/policy/policy.js';
import { setMockScript } from '../src/llm/provider.js';
import { QuietUi } from '../src/ui/render.js';
import { ChatResult } from '../src/llm/types.js';
import { diffReport, forkSession, rewindSession } from '../src/commands.js';
import { detectSandbox, globToEre, setSandboxProbe } from '../src/tools/sandbox.js';
import { globMatch } from '../src/util/glob.js';

process.env.KEEL_MOCK = '1';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-control-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  process.env.KEEL_HOME = path.join(root, 'home');
  const cfg = defaultConfig();
  const store = SessionStore.create({ cwd, model: cfg.router.main, interactive: false });
  return { root, cwd, cfg, store };
}

let n = 0;
function calls(...list: [string, unknown][]): ChatResult {
  return {
    message: { content: null, tool_calls: list.map(([name, args]) => ({ id: `c${++n}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })) },
    usage: { inputTokens: 10, outputTokens: 1 },
  };
}
const done = (): ChatResult => ({ message: { content: 'done', tool_calls: [] }, usage: { inputTokens: 10, outputTokens: 1 } });

async function turn(ctx: { store: SessionStore; cfg: KeelConfig }, script: (() => ChatResult)[], autoApprove = false) {
  setMockScript(script);
  return runUserTurn({ store: ctx.store, cfg: ctx.cfg, ui: new QuietUi(), interactive: false, userText: 'task', autoApprove });
}

const read = (cwd: string, p: string) => fs.readFileSync(path.join(cwd, p), 'utf8');

test('write scope: protectPaths (default .keel.json) is readable but not writable; writePaths and approvePaths scope edits', () => {
  const cwd = '/tmp/keel-scope';
  const p = { ...defaultConfig().policy };
  assert.equal(checkPolicy(p, { tool: 'write', input: { path: '.keel.json' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'edit', input: { path: './.keel.json' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'read', input: { path: '.keel.json' }, cwd }).decision, 'allow');
  const scoped = { ...p, writePaths: ['src/**'], approvePaths: ['src/db/**', 'package.json'] };
  assert.equal(checkPolicy(scoped, { tool: 'write', input: { path: 'src/a.ts' }, cwd }).decision, 'allow');
  assert.match(checkPolicy(scoped, { tool: 'write', input: { path: 'test/a.test.ts' }, cwd }).rule!, /writePaths/);
  assert.equal(checkPolicy(scoped, { tool: 'read', input: { path: 'test/a.test.ts' }, cwd }).decision, 'allow');
  assert.equal(checkPolicy(scoped, { tool: 'edit', input: { path: 'src/db/migrate.ts' }, cwd }).decision, 'approve');
  assert.throws(() => validateConfig({ ...defaultConfig(), sandbox: { mode: 'strict' as 'off', network: false, writablePaths: [] } }), /sandbox.mode/);
  assert.throws(() => validateConfig({ ...defaultConfig(), hooks: { preTool: [{ command: '' }] } }), /hooks.preTool\[0\]/);
});

test('hooks: exit 2 denies with an audited reason, JSON can escalate to approval, and hooks never relax built-in denies', async () => {
  const ctx = fixture();
  const seen = path.join(ctx.root, 'hook-input.jsonl');
  ctx.cfg.hooks.preTool = [
    { command: `cat >> ${seen}`, tools: ['bash'] },
    { command: `if grep -q forbidden; then echo "no forbidden things" >&2; exit 2; fi` },
    { command: `if grep -q '"path":"secret.txt"'; then echo '{"decision":"approve","reason":"needs a human"}'; fi` },
  ];
  ctx.cfg.policy.bashDeny.push('touch denied*');
  await turn(ctx, [() => calls(
    ['bash', { command: 'touch forbidden.txt' }],
    ['write', { path: 'secret.txt', content: 'x' }],
    ['write', { path: 'ok.txt', content: 'ok' }],
    ['bash', { command: 'touch denied.txt' }],
  ), done]);
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'forbidden.txt')));
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'secret.txt')), 'approval escalated by hook; noninteractive rejects it');
  assert.equal(read(ctx.cwd, 'ok.txt'), 'ok');
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'denied.txt')));
  const decisions = ctx.store.readAll().filter((e) => e.type === 'policy.decision').map((e) => e.data as any);
  assert.equal(decisions[0].decision, 'deny');
  assert.match(decisions[0].rule, /no forbidden things/);
  assert.deepEqual(decisions[0].hooks.map((h: any) => h.decision), ['allow', 'deny']);
  assert.equal(decisions[1].decision, 'approve');
  assert.match(decisions[1].rule, /needs a human/);
  assert.equal(decisions[2].decision, 'allow');
  assert.equal(decisions[3].decision, 'deny');
  assert.match(decisions[3].rule, /bashDeny/);
  assert.equal(decisions[3].hooks, undefined, 'built-in deny short-circuits hooks');
  // The hook saw the full request as JSON on stdin, and only for bash.
  const inputs = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(inputs.map((i) => i.tool), ['bash']);
  assert.equal(inputs[0].input.command, 'touch forbidden.txt');
  assert.equal(inputs[0].session, ctx.store.id);
});

test('hooks: crashes, bad output and timeouts fail closed', async () => {
  for (const hook of [{ command: 'exit 1' }, { command: 'echo not-json' }, { command: 'sleep 5', timeoutMs: 200 }]) {
    const ctx = fixture();
    ctx.cfg.hooks.preTool = [hook];
    await turn(ctx, [() => calls(['write', { path: 'a.txt', content: 'x' }]), done]);
    assert.ok(!fs.existsSync(path.join(ctx.cwd, 'a.txt')), hook.command);
    const decision = ctx.store.readAll().find((e) => e.type === 'policy.decision')!.data as any;
    assert.equal(decision.decision, 'deny', hook.command);
  }
});

test('checkpoints: diff shows write/edit changes, rewind undoes the last turn, then the whole session', async () => {
  const ctx = fixture();
  await turn(ctx, [() => calls(['write', { path: 'a.txt', content: 'one\n' }]), done]);
  await turn(ctx, [() => calls(['edit', { path: 'a.txt', oldText: 'one', newText: 'two' }], ['write', { path: 'sub/b.txt', content: 'new\n' }]), done]);
  const changed = ctx.store.readAll().filter((e) => e.type === 'file.changed');
  assert.equal(changed.length, 3);
  const diff = diffReport(ctx.store.id, null);
  assert.match(diff, /\+\+\+ b\/a\.txt/);
  assert.match(diff, /\+two/);
  assert.match(diff, /\+\+\+ b\/sub\/b\.txt/);

  const undo = rewindSession(ctx.store.id, null);
  assert.equal(undo.restored, 2);
  assert.equal(read(ctx.cwd, 'a.txt'), 'one\n');
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'sub/b.txt')), 'files created in the turn are removed');
  const events = SessionStore.open(ctx.store.id).readAll();
  assert.equal(events.at(-2)!.type, 'workspace.rewound');
  assert.equal(events.at(-1)!.type, 'verify.invalidated');
  assert.equal(diffReport(ctx.store.id, events.at(-1)!.seq), '（检查点内没有文件改动）');

  assert.equal(rewindSession(ctx.store.id, 0).restored, 1);
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'a.txt')));
  assert.equal(rewindSession(ctx.store.id, 0).restored, 0, 'rewind is idempotent');
});

test('checkpoints: rewind refuses to clobber edits made outside the checkpoint unless forced', async () => {
  const ctx = fixture();
  await turn(ctx, [() => calls(['write', { path: 'a.txt', content: 'agent\n' }]), done]);
  fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'human edit\n');
  assert.throws(() => rewindSession(ctx.store.id, 0), /a\.txt: 当前内容与检查点记录不一致/);
  assert.equal(read(ctx.cwd, 'a.txt'), 'human edit\n');
  assert.equal(SessionStore.open(ctx.store.id).readAll().filter((e) => e.type === 'workspace.rewound').length, 0);
  assert.equal(rewindSession(ctx.store.id, 0, true).restored, 1);
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'a.txt')));
});

test('checkpoints: fork --rewind restores files to the fork point and keeps both histories consistent', async () => {
  const ctx = fixture();
  await turn(ctx, [() => calls(['write', { path: 'a.txt', content: 'v1\n' }]), done]);
  const forkPoint = ctx.store.seq;
  await turn(ctx, [() => calls(['write', { path: 'a.txt', content: 'v2\n' }], ['write', { path: 'c.txt', content: 'c\n' }]), done]);
  const child = forkSession(ctx.store.id, forkPoint, { rewind: true });
  assert.equal(read(ctx.cwd, 'a.txt'), 'v1\n');
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'c.txt')));
  const rewound = child.readAll().find((e) => e.type === 'workspace.rewound')!.data as any;
  assert.equal(rewound.fromSession, ctx.store.id);
  assert.equal(fold(child.readAll()).lastVerifyOkSeq, 0);
  // The child can continue editing and rewind its own changes with copied snapshots.
  await turn({ store: child, cfg: ctx.cfg }, [() => calls(['write', { path: 'a.txt', content: 'v3\n' }]), done]);
  assert.equal(rewindSession(child.id, null).restored, 1);
  assert.equal(read(ctx.cwd, 'a.txt'), 'v1\n');
  // The parent sees the workspace no longer matches its head and refuses a blind rewind.
  assert.throws(() => rewindSession(ctx.store.id, 0), /不一致/);
});

test('sandbox: requested but unavailable fails closed and is audited', async () => {
  const ctx = fixture();
  ctx.cfg.sandbox.mode = 'workspace-write';
  setSandboxProbe(null);
  try {
    await turn(ctx, [() => calls(['bash', { command: 'touch ran.txt' }]), done]);
  } finally { setSandboxProbe(undefined); }
  assert.ok(!fs.existsSync(path.join(ctx.cwd, 'ran.txt')));
  const events = ctx.store.readAll();
  assert.equal((events.find((e) => e.type === 'tool.call')!.data as any).sandbox, 'unavailable');
  assert.match((events.find((e) => e.type === 'tool.result')!.data as any).output, /没有可用的 OS 沙箱/);
});

test('sandbox: glob translation agrees with the policy matcher', () => {
  const root = '/w';
  const cases: [string, string, boolean][] = [
    ['**/.env', 'a/b/.env', true], ['**/.env', '.env', true], ['**/.env', '.envrc', false],
    ['.keel.json', '.keel.json', true], ['.keel.json', 'pkg/.keel.json', true],
    ['*.pem', 'certs/x.pem', true], ['src/**', 'src/a/b.ts', true], ['src/**', 'srcx/a.ts', false],
    ['.git/**', '.git/HEAD', true], ['test/*.ts', 'test/a.ts', true], ['test/*.ts', 'test/x/a.ts', false],
  ];
  for (const [glob, rel, want] of cases) {
    assert.equal(new RegExp(globToEre(root, glob)).test(`${root}/${rel}`), want, `${glob} vs ${rel}`);
    assert.equal(globMatch(glob, rel), want, `globMatch ${glob} vs ${rel}`);
  }
});

const kind = detectSandbox();
// CI sets KEEL_REQUIRE_SANDBOX=1 so a broken probe fails the run instead of silently skipping.
const requireSandbox = process.env.KEEL_REQUIRE_SANDBOX === '1';
test('sandbox: real OS sandbox confines bash writes, secrets, protected files, the event store and the network', { skip: kind || requireSandbox ? false : 'no OS sandbox on this host' }, async () => {
  assert.ok(kind, 'KEEL_REQUIRE_SANDBOX=1 but no OS sandbox was detected');
  const ctx = fixture();
  ctx.cfg.sandbox.mode = 'workspace-write';
  fs.writeFileSync(path.join(ctx.cwd, '.env'), 'SECRET_SENTINEL');
  fs.writeFileSync(path.join(ctx.cwd, '.keel.json'), '{}');
  fs.mkdirSync(path.join(ctx.cwd, '.git'));
  fs.writeFileSync(path.join(ctx.cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  // Outside the workspace and outside temp dirs: next to this test file.
  const escape = fileURLToPath(new URL(`./.sandbox-escape-${process.pid}`, import.meta.url));
  const eventsFile = path.join(ctx.store.dir, 'events.jsonl');
  try {
    await turn(ctx, [() => calls(
      ['bash', { command: 'echo inside > inside.txt' }],
      ['bash', { command: `echo out > ${escape}` }],
      ['bash', { command: 'cat .env' }],
      ['bash', { command: `echo '{"policy":{"readOnly":false}}' > .keel.json` }],
      ['bash', { command: `cat ${eventsFile}` }],
      ['bash', { command: `node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(9))"` }],
      ['bash', { command: 'cat .git/HEAD && touch .git/new-ref' }],
    ), done]);
    assert.equal(read(ctx.cwd, 'inside.txt'), 'inside\n');
    assert.ok(!fs.existsSync(escape), 'write outside the workspace must fail');
    assert.equal(read(ctx.cwd, '.keel.json'), '{}');
    const results = ctx.store.readAll().filter((e) => e.type === 'tool.result').map((e) => e.data as any);
    assert.deepEqual(results.map((r) => r.ok), [true, false, false, false, false, false, false]);
    assert.ok(!results[2].output.includes('SECRET_SENTINEL'));
    assert.ok(!results[4].output.includes('session.started'));
    // .git stays readable for git itself, but nothing new can be written into it.
    assert.match(results[6].output, /refs\/heads\/main/);
    assert.ok(!fs.existsSync(path.join(ctx.cwd, '.git', 'new-ref')));
    const sandboxes = ctx.store.readAll().filter((e) => e.type === 'tool.call').map((e) => (e.data as any).sandbox);
    assert.deepEqual([...new Set(sandboxes)], [kind]);
  } finally { fs.rmSync(escape, { force: true }); }
});

test('CLI: run --json streams every event as JSONL on stdout', () => {
  const ctx = fixture();
  const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'run', '--json', '--cwd', ctx.cwd, 'write hello'], {
    env: { ...process.env, KEEL_MOCK: '1', KEEL_MODEL: 'deepseek/deepseek-chat' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'session.started');
  assert.equal(events.at(-1).type, 'turn.completed');
  assert.equal(events.at(-1).data.stopReason, 'done');
  assert.ok(events.some((e) => e.type === 'file.changed'));
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  // A consumer that disconnects early must not crash the run.
  const early = spawnSync('/bin/bash', ['-c', `"${process.execPath}" "${cli}" run --json --cwd "${ctx.cwd}" 'write hello' | head -c 10 >/dev/null; echo "\${PIPESTATUS[0]}"`], {
    env: { ...process.env, KEEL_MOCK: '1', KEEL_MODEL: 'deepseek/deepseek-chat' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(early.stdout.trim(), '0', early.stderr);
  assert.equal(SessionStore.list()[0]!.title, 'write hello');
  const last = SessionStore.open(SessionStore.list()[0]!.id).readAll().at(-1)!;
  assert.equal(last.type, 'turn.completed');
});
