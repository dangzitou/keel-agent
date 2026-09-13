import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Event, EventName } from '../events/types.js';
import { newEventId, newSessionId } from '../util/ids.js';

export interface SessionMeta {
  id: string;
  parent: string | null;
  forkedAtSeq: number | null;
  cwd: string;
  title: string;
  model: string;
  interactive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** KEEL_HOME：事件与配置的家目录（测试用环境变量覆盖） */
export function keelHome(): string {
  return process.env.KEEL_HOME ?? path.join(os.homedir(), '.keel');
}

export function sessionsRoot(): string {
  return path.join(keelHome(), 'sessions');
}

/**
 * 会话存储：目录内一个 append-only 的 events.jsonl + meta.json + evidence/。
 * 事件一旦写入不再修改；fork 是"复制前缀"，不是改写历史。
 */
export class SessionStore {
  readonly dir: string;
  private readonly eventsFile: string;
  private _seq = 0;
  /** 已解析事件缓存：append 增量维护，避免长会话反复全量读盘 */
  private cache: Event[] | null = null;
  meta: SessionMeta;

  private constructor(dir: string, meta: SessionMeta, seq: number) {
    this.dir = dir;
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.meta = meta;
    this._seq = seq;
  }

  get id(): string {
    return this.meta.id;
  }

  get seq(): number {
    return this._seq;
  }

  static dirOf(id: string): string {
    return path.join(sessionsRoot(), id);
  }

  static create(opts: {
    cwd: string;
    model: string;
    interactive: boolean;
    parent?: string | null;
    forkedAtSeq?: number | null;
    id?: string;
  }): SessionStore {
    const id = opts.id ?? newSessionId();
    const dir = SessionStore.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      parent: opts.parent ?? null,
      forkedAtSeq: opts.forkedAtSeq ?? null,
      cwd: opts.cwd,
      title: '',
      model: opts.model,
      interactive: opts.interactive,
      createdAt: now,
      updatedAt: now,
    };
    const store = new SessionStore(dir, meta, 0);
    store.saveMeta();
    return store;
  }

  static open(id: string): SessionStore {
    const dir = SessionStore.dirOf(id);
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) {
      throw new Error(`会话不存在: ${id}（用 keel sessions 查看已有会话）`);
    }
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as SessionMeta;
    const store = new SessionStore(dir, meta, 0);
    const events = store.readAll();
    store.resumeFrom(events.length ? events[events.length - 1]!.seq : 0);
    return store;
  }

  static exists(id: string): boolean {
    return fs.existsSync(path.join(SessionStore.dirOf(id), 'meta.json'));
  }

  static list(): SessionMeta[] {
    const root = sessionsRoot();
    if (!fs.existsSync(root)) return [];
    const out: SessionMeta[] = [];
    for (const name of fs.readdirSync(root)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8')) as SessionMeta;
        out.push(meta);
      } catch {
        /* 跳过损坏的会话目录 */
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** 追加一条事件；seq 单调递增 */
  append<T>(type: EventName, data: T): Event<T> {
    this._seq += 1;
    const e: Event<T> = {
      seq: this._seq,
      id: newEventId(),
      ts: new Date().toISOString(),
      session: this.meta.id,
      parent: this.meta.parent,
      forkedAtSeq: this.meta.forkedAtSeq,
      type,
      data,
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(e) + '\n', 'utf8');
    this.cache?.push(e as Event);
    this.meta.updatedAt = e.ts;
    this.saveMeta();
    return e;
  }

  /** fork/open 场景：把写入游标定位到既有事件流的尾部 */
  resumeFrom(seq: number): void {
    this._seq = seq;
  }

  /** fork 用：整体写入一段事件前缀（session 字段由调用方改写为目标会话） */
  importPrefix(events: Event[]): void {
    fs.writeFileSync(this.eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
    this._seq = events.length ? events[events.length - 1]!.seq : 0;
    this.cache = null;
  }

  /** 返回缓存引用——调用方不得原地修改（fold 是只读遍历） */
  readAll(): Event[] {
    if (this.cache) return this.cache;
    const out: Event[] = [];
    if (fs.existsSync(this.eventsFile)) {
      for (const line of fs.readFileSync(this.eventsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* 尾部半行（崩溃残留）直接忽略：append-only 日志的可容忍点 */
        }
      }
    }
    this.cache = out;
    return out;
  }

  evidenceDir(): string {
    const d = path.join(this.dir, 'evidence');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  setTitle(title: string): void {
    if (!this.meta.title && title) {
      this.meta.title = title;
      this.saveMeta();
    }
  }

  saveMeta(): void {
    fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2), 'utf8');
  }
}
