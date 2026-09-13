import { Event } from './events/types.js';
import { SessionStore } from './core/store.js';
import { fold } from './core/fold.js';
import { renderEventLine, Ui } from './ui/render.js';

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
