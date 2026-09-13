import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { Event } from './events/types.js';
import { SessionStore, keelHome } from './core/store.js';
import { fold } from './core/fold.js';
import { renderEventLine, Ui } from './ui/render.js';
import { hasKnownPrice } from './llm/cost.js';
import { loadConfig } from './config.js';

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

/** 从父会话 fork：复制事件前缀到新会话，新事件从断点之后继续追加 */
export function forkSession(parentId: string, atSeq: number | null): SessionStore {
  const parent = SessionStore.open(parentId);
  const all = parent.readAll();
  const prefix = atSeq == null ? all : all.filter((e) => e.seq <= atSeq);
  if (atSeq != null && !prefix.length) {
    throw new Error(`事件序号 ${atSeq} 超出会话范围（父会话共 ${parent.seq} 个事件）`);
  }
  const child = SessionStore.create({
    cwd: parent.meta.cwd,
    model: parent.meta.model,
    interactive: true,
    parent: parentId,
    forkedAtSeq: atSeq ?? parent.seq,
  });
  child.importPrefix(prefix.map((e) => ({ ...e, session: child.id })));
  child.setTitle(`fork of ${parentId} @${child.meta.forkedAtSeq}`);
  child.saveMeta();
  return child;
}

export function costReport(id: string, ui: Ui): void {
  const store = SessionStore.open(id);
  const st = fold(store.readAll());
  ui.status(`会话 ${id} 成本报告（fold 自事件流，可审计）`);
  ui.status(`回合数: ${st.turns} · 总花费: $${st.spend.totalUsd.toFixed(4)} · tokens ↑${st.spend.inputTokens} ↓${st.spend.outputTokens}`);
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
export function doctor(): { checks: DoctorCheck[]; ok: boolean } {
  const checks: DoctorCheck[] = [];
  const add = (name: string, level: DoctorCheck['level'], detail: string) => checks.push({ name, level, detail });

  const [maj, min] = process.versions.node.split('.').map(Number);
  add('node', maj! > 18 || (maj === 18 && min! >= 17) ? 'ok' : 'fail', `node ${process.versions.node}（要求 >= 18.17）`);

  try {
    fs.mkdirSync(keelHome(), { recursive: true });
    fs.accessSync(keelHome(), fs.constants.W_OK);
    add('keel-home', 'ok', keelHome());
  } catch (e) {
    add('keel-home', 'fail', `不可写: ${(e as Error).message}`);
  }

  let cfg;
  try {
    cfg = loadConfig().cfg;
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
    if (!hasKnownPrice(ref)) {
      add(`price.${role}`, 'warn', `${ref} 不在价目表中，费用将记为 $0（可在 src/llm/cost.ts 增补）`);
    }
  }

  if (cfg.verify.commands.length === 0) {
    add('verify', 'warn', 'verify.commands 为空：完成契约要求 agent 显式传命令，建议在 .keel.json 配置（如 ["npm test"]）');
  } else {
    add('verify', 'ok', cfg.verify.commands.join(' && '));
  }

  try {
    execSync('git --version', { stdio: 'ignore' });
    add('git', 'ok', '可用');
  } catch {
    add('git', 'warn', '不可用：会话将缺少分支信息');
  }

  return { checks, ok: checks.every((c) => c.level !== 'fail') };
}
