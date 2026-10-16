import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Event, FileChange } from '../events/types.js';
import { SessionStore } from './store.js';
import { canonicalPath } from '../policy/policy.js';

interface ChangeRecord extends FileChange {
  seq: number;
}

/** 从事件流取出所有检查点记录：write/edit 的 file.changed 与 rewind 本身 */
function timeline(events: Event[]): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const e of events as Event<any>[]) {
    if (e.type === 'file.changed' || e.type === 'workspace.rewound') {
      for (const c of (e.type === 'file.changed' ? e.data.changes : e.data.restored) as FileChange[]) out.push({ ...c, seq: e.seq });
    }
  }
  return out;
}

export interface PathState {
  sha: string | null;
  /** 该路径在这个区间里有过无快照的改动，内容不可还原 */
  untracked: boolean;
}

/**
 * 检查点视角下 seq 时刻的文件内容：seq 之前最后一次改动的 after；
 * seq 之前没动过的文件，取它之后第一次改动的 before（即会话动它之前的原样）。
 */
export function stateAt(events: Event[], seq: number): Map<string, PathState> {
  const state = new Map<string, PathState>();
  for (const c of timeline(events)) {
    const cur = state.get(c.path);
    if (c.seq <= seq) state.set(c.path, { sha: c.after, untracked: false });
    else if (!cur) state.set(c.path, { sha: c.before, untracked: !!c.untracked });
  }
  return state;
}

function shaOf(abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

export interface PlannedRestore {
  path: string;
  from: string | null;
  to: string | null;
  /** 磁盘现状与检查点记录不一致（被 bash/外部修改过），或原内容没有快照 */
  conflict: string | null;
}

/** 计算把工作目录恢复到 toSeq 需要改哪些文件；只读，不碰磁盘以外的状态 */
export function planRewind(events: Event[], toSeq: number, cwd: string): PlannedRestore[] {
  const target = stateAt(events, toSeq);
  const head = stateAt(events, Number.MAX_SAFE_INTEGER);
  const plan: PlannedRestore[] = [];
  for (const [p, want] of target) {
    const expected = head.get(p)!;
    if (want.sha === expected.sha) continue;
    const actual = shaOf(path.resolve(cwd, p));
    const conflict = want.untracked ? '原内容没有快照（文件过大或不是普通文件）'
      : actual !== expected.sha ? '当前内容与检查点记录不一致（可能被 bash 或外部修改）'
      : null;
    plan.push({ path: p, from: actual, to: want.sha, conflict });
  }
  return plan;
}

/** 执行恢复：有冲突时整体拒绝（除非 force），避免半途覆盖用户的手工修改 */
export function applyRewind(plan: PlannedRestore[], blobs: SessionStore, cwd: string, force = false): FileChange[] {
  const conflicts = plan.filter((p) => p.conflict && !(force && !p.conflict.startsWith('原内容没有快照')));
  if (conflicts.length) {
    throw new Error(`无法 rewind，以下文件有冲突${force ? '' : '（--force 可覆盖内容不一致的文件）'}:\n${conflicts.map((c) => `  ${c.path}: ${c.conflict}`).join('\n')}`);
  }
  const restored: FileChange[] = [];
  for (const p of plan) {
    // 与 write 工具一致：写到符号链接的目标，而不是把链接替换成普通文件
    const abs = canonicalPath(path.resolve(cwd, p.path));
    if (p.to === null) fs.rmSync(abs, { force: true });
    else {
      const content = blobs.getBlob(p.to);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.keel-rewind-${process.pid}.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, abs);
    }
    restored.push({ path: p.path, before: p.from, after: p.to });
  }
  return restored;
}

/** 会话从 fromSeq 到现在由 write/edit 造成的改动，输出统一 diff（借用系统 diff -u，保持零依赖） */
export function sessionDiff(store: SessionStore, fromSeq = 0): string {
  const events = store.readAll();
  const base = stateAt(events, fromSeq);
  const head = stateAt(events, Number.MAX_SAFE_INTEGER);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-diff-'));
  const parts: string[] = [];
  try {
    for (const [p, b] of base) {
      const h = head.get(p)!;
      if (b.sha === h.sha) continue;
      const side = (sha: string | null, name: string) => {
        if (sha === null) return '/dev/null';
        const f = path.join(tmp, name);
        fs.writeFileSync(f, store.getBlob(sha));
        return f;
      };
      if (b.untracked) { parts.push(`--- ${p}: 原内容没有快照，无法给出 diff`); continue; }
      const r = spawnSync('diff', ['-u', '--label', b.sha ? `a/${p}` : '/dev/null', '--label', h.sha ? `b/${p}` : '/dev/null', side(b.sha, 'a'), side(h.sha, 'b')], { encoding: 'utf8' });
      parts.push(r.stdout || `--- ${p}: 二进制或无法比较`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const bashCalls = events.filter((e) => e.seq > fromSeq && e.type === 'tool.call' && (e.data as any).tool === 'bash').length;
  if (bashCalls) parts.push(`（另有 ${bashCalls} 次 bash 调用：它们的改动不在检查点内，请用 git diff 核对）`);
  return parts.join('\n');
}
