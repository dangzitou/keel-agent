import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { Event } from './events/types.js';
import { SessionStore, keelHome } from './core/store.js';
import { fold } from './core/fold.js';
import { renderEventLine, Ui } from './ui/render.js';
import { hasKnownPrice } from './llm/cost.js';
import { loadConfig } from './config.js';
import { applyRewind, planRewind, sessionDiff } from './core/checkpoint.js';
import { detectSandbox } from './tools/sandbox.js';

/** 最近一个会话的 id（keel continue / replay / cost 省略参数时用） */
export function latestSessionId(): string {
  const metas = SessionStore.list();
  if (!metas.length) {
    throw new Error('还没有任何会话。先用 keel run "任务" 或交互模式开一个。');
  }
  for (const meta of metas) {
    const events = SessionStore.open(meta.id).readAll();
    if (events.some((event) => event.type !== 'session.started')) {
      return meta.id;
    }
  }
  throw new Error('还没有可用会话。先用 keel run "任务" 或交互模式输入一个任务。');
}

export function listSessions(ui: Ui): void {
  const metas = SessionStore.list();
  if (!metas.length) {
    ui.note('还没有会话。用 keel run "任务" 或直接 keel 进入交互模式。');
    return;
  }
  for (const m of metas) {
    let extra = '';
    try {
      const store = SessionStore.open(m.id);
      const st = fold(store.readAll());
      extra = `${ansiTurns(st.turns)} 回合 · $${st.spend.totalUsd.toFixed(4)}${st.lastFileModSeq > st.lastVerifyOkSeq ? ' · ⚠有未验证修改' : ''}`;
    } catch {
      extra = '(事件流损坏)';
    }
    const forkMark = m.parent ? ` ↳fork自 ${m.parent.slice(-10)}@${m.forkedAtSeq}` : '';
    ui.status(`${m.id}  ${(m.title || '(无标题)').slice(0, 44)}  ${extra}${forkMark}`);
  }
}

function ansiTurns(n: number): string {
  return String(n);
}

export function replaySession(id: string, ui: Ui): void {
  const store = SessionStore.open(id);
  const events = store.readAll();
  ui.status(`回放会话 ${id}（${events.length} 个事件，只读）`);
  for (const e of events) {
    const line = renderEventLine(e);
    if (line) console.log(`[${String(e.seq).padStart(4)}] ${line}`);
  }
}

/** 省略断点时 rewind 撤销最近一轮：回到最后一条用户输入之前 */
function lastTurnStart(events: Event[]): number {
  const last = events.filter((e) => e.type === 'user.message').at(-1);
  return last ? last.seq - 1 : 0;
}

/** keel diff：从 fromSeq（默认会话开始）到现在，write/edit 造成的改动 */
export function diffReport(id: string, fromSeq: number | null): string {
  const store = SessionStore.open(id);
  return sessionDiff(store, fromSeq ?? 0) || '（检查点内没有文件改动）';
}

/**
 * keel rewind：把 write/edit 改过的文件恢复到 toSeq 时的内容，并记 workspace.rewound + verify.invalidated。
 * 磁盘现状与检查点不一致时拒绝（--force 覆盖），从不默默丢掉 bash 或人手改的内容。
 */
export function rewindSession(id: string, toSeq: number | null, force = false): { store: SessionStore; restored: number; toSeq: number } {
  const store = SessionStore.open(id);
  const release = store.lock();
  try {
    const events = store.readAll();
    const at = toSeq ?? lastTurnStart(events);
    if (!Number.isSafeInteger(at) || at < 0 || at > store.seq) throw new Error(`事件序号 ${at} 超出会话范围（共 ${store.seq} 个事件）`);
    const restored = applyRewind(planRewind(events, at, store.meta.cwd), store, store.meta.cwd, force);
    if (restored.length) {
      store.append('workspace.rewound', { toSeq: at, fromSession: store.id, restored });
      store.append('verify.invalidated', { reason: `工作目录已 rewind 到事件 ${at}，需重新验证。` });
    }
    return { store, restored: restored.length, toSeq: at };
  } finally { release(); }
}

/** 从父会话 fork：复制事件前缀到新会话，新事件从断点之后继续追加；rewind=true 时同时把文件恢复到断点 */
export function forkSession(parentId: string, atSeq: number | null, opts: { rewind?: boolean; force?: boolean } = {}): SessionStore {
  const parent = SessionStore.open(parentId);
  const all = parent.readAll();
  if (atSeq != null && (!Number.isSafeInteger(atSeq) || atSeq < 1 || atSeq > parent.seq)) {
    throw new Error(`事件序号 ${atSeq} 超出会话范围（父会话共 ${parent.seq} 个事件）`);
  }
  const prefix = atSeq == null ? all : all.filter((e) => e.seq <= atSeq);
  if (atSeq != null && !prefix.length) {
    throw new Error(`事件序号 ${atSeq} 超出会话范围（父会话共 ${parent.seq} 个事件）`);
  }
  // 先算恢复计划：有冲突就在建子会话之前失败
  const plan = opts.rewind ? planRewind(all, atSeq ?? parent.seq, parent.meta.cwd) : [];
  const child = SessionStore.create({
    cwd: parent.meta.cwd,
    model: parent.meta.model,
    interactive: true,
    parent: parentId,
    forkedAtSeq: atSeq ?? parent.seq,
  });
  child.importPrefix(prefix.map((e) => ({ ...e, session: child.id })));
  if (fs.existsSync(parent.blobDir())) fs.cpSync(parent.blobDir(), child.blobDir(), { recursive: true });
  const restored = opts.rewind ? applyRewind(plan, child, parent.meta.cwd, opts.force) : [];
  if (restored.length) child.append('workspace.rewound', { toSeq: child.meta.forkedAtSeq, fromSession: parentId, restored });
  child.append('verify.invalidated', { reason: opts.rewind
    ? `分叉并把检查点内的文件恢复到事件 ${child.meta.forkedAtSeq}（bash 的改动未回滚），需重新验证。`
    : '分叉保留历史，但工作目录未回滚，需重新验证。' });
  child.setTitle(`fork of ${parentId} @${child.meta.forkedAtSeq}`);
  child.saveMeta();
  return child;
}

export function costReport(id: string, ui: Ui): void {
  const store = SessionStore.open(id);
  const st = fold(store.readAll());
  ui.status(`会话 ${id} 成本报告（fold 自事件流，可审计）`);
  ui.status(`回合数: ${st.turns} · 总花费: $${st.spend.totalUsd.toFixed(4)} · tokens ↑${st.spend.inputTokens} ↓${st.spend.outputTokens}`);
  if (st.spend.unpricedCalls) ui.warn(`${st.spend.unpricedCalls} 次调用价目未知，美元合计不完整；token 使用量仍已记录。`);
  for (const [model, s] of Object.entries(st.spend.byModel)) {
    ui.status(`  ${model}: ${s.calls} 次调用 · ↑${s.inputTokens} ↓${s.outputTokens} · $${s.usd.toFixed(4)}`);
  }
  if (st.filesTouched.length) {
    ui.status(`修改过的文件: ${[...new Set(st.filesTouched)].join(', ')}`);
  }
  ui.status(`验证状态: ${st.lastFileModSeq > st.lastVerifyOkSeq ? '⚠ 有文件修改未通过验证' : '✓ 全部修改已验证（或无修改）'}`);
}

/** 导出事件流为 JSON（对接评测/回归集的口子） */
export function exportEvents(id: string): Event[] {
  return SessionStore.open(id).readAll();
}

export interface DoctorCheck {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** 环境体检：配置、密钥、价目、验证命令、目录可写性，生产部署前先跑一遍 */
export function doctor(cwd = process.cwd()): { checks: DoctorCheck[]; ok: boolean } {
  const checks: DoctorCheck[] = [];
  const add = (name: string, level: DoctorCheck['level'], detail: string) => checks.push({ name, level, detail });

  const [maj] = process.versions.node.split('.').map(Number);
  add('node', maj! >= 20 ? 'ok' : 'fail', `node ${process.versions.node}（要求 >= 20）`);

  try {
    fs.mkdirSync(keelHome(), { recursive: true });
    fs.accessSync(keelHome(), fs.constants.W_OK);
    add('keel-home', 'ok', keelHome());
  } catch (e) {
    add('keel-home', 'fail', `不可写: ${(e as Error).message}`);
  }

  let cfg;
  try {
    cfg = loadConfig(cwd).cfg;
    add('config', 'ok', `router.main=${cfg.router.main}`);
  } catch (e) {
    add('config', 'fail', (e as Error).message);
    return { checks, ok: false };
  }

  for (const role of ['main', 'fast'] as const) {
    const ref = cfg.router[role];
    const slash = ref.indexOf('/');
    if (slash < 1) {
      add(`router.${role}`, 'fail', `"${ref}" 格式应为 provider/model`);
      continue;
    }
    const providerName = ref.slice(0, slash);
    const pcfg = cfg.providers[providerName];
    if (!pcfg) {
      add(`router.${role}`, 'fail', `未知 provider "${providerName}"`);
      continue;
    }
    if (process.env.KEEL_MOCK === '1') {
      add(`router.${role}`, 'warn', 'KEEL_MOCK=1，使用确定性 mock 模型');
    } else if (!process.env[pcfg.apiKeyEnv]) {
      add(`router.${role}`, 'fail', `缺少环境变量 ${pcfg.apiKeyEnv}`);
    } else {
      add(`router.${role}`, 'ok', `${ref}（${pcfg.apiKeyEnv} 已设置）`);
    }
    if (!hasKnownPrice(ref, cfg.pricing)) {
      add(`price.${role}`, 'warn', `${ref} 价目未知，美元合计不完整；可在 pricing 配置 USD/百万 token，token 上限仍生效`);
    }
  }

  if (cfg.verify.commands.length === 0) {
    add('verify', 'warn', 'verify.commands 为空：完成契约要求 agent 显式传命令，建议在 .keel.json 配置（如 ["npm test"]）');
  } else {
    add('verify', 'ok', cfg.verify.commands.join(' && '));
  }

  const sandbox = detectSandbox();
  if (cfg.sandbox.mode === 'off') add('sandbox', 'warn', `未开启：bash/verify 不受 OS 隔离${sandbox ? `（本机可用 ${sandbox}，设 sandbox.mode="workspace-write" 开启）` : ''}`);
  else add('sandbox', sandbox ? 'ok' : 'fail', sandbox
    ? `${sandbox} · ${cfg.sandbox.mode} · 外网${cfg.sandbox.network ? '开' : '关'}`
    : '已要求开启，但本机没有 sandbox-exec / bwrap：bash 与 verify 将被拒绝执行');
  if (cfg.hooks.preTool.length) add('hooks', 'ok', `preTool × ${cfg.hooks.preTool.length}: ${cfg.hooks.preTool.map((h) => h.command).join(' ; ')}`);

  try {
    execSync('git --version', { stdio: 'ignore' });
    add('git', 'ok', '可用');
  } catch {
    add('git', 'warn', '不可用：会话将缺少分支信息');
  }

  return { checks, ok: checks.every((c) => c.level !== 'fail') };
}
