import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
  private cacheBytes = -1;
  private validBytes = 0;
  private locked = false;
  meta: SessionMeta;
  /** 每条新事件落盘后回调（keel run --json 用它把事件流实时推给编排方） */
  onAppend?: (e: Event) => void;

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
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('非法会话 id');
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
    fs.mkdirSync(sessionsRoot(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      parent: opts.parent ?? null,
      forkedAtSeq: opts.forkedAtSeq ?? null,
      cwd: path.resolve(opts.cwd),
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
    if (meta.id !== id || typeof meta.cwd !== 'string' || !path.isAbsolute(meta.cwd)) throw new Error('会话元数据损坏');
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
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1));
  }

  /** 追加一条事件；seq 单调递增 */
  append<T>(type: EventName, data: T): Event<T> {
    const release = this.locked ? () => {} : this.lock();
    try {
      const events = this.readAll();
      this._seq = events.at(-1)?.seq ?? 0;
      const bytes = fs.existsSync(this.eventsFile) ? fs.statSync(this.eventsFile).size : 0;
      if (bytes > this.validBytes) {
        const tail = fs.readFileSync(this.eventsFile).subarray(this.validBytes);
        fs.writeFileSync(path.join(this.dir, `torn-tail-${newEventId()}.bin`), tail, { mode: 0o600 });
        fs.truncateSync(this.eventsFile, this.validBytes);
      }
      const e: Event<T> = {
        seq: this._seq + 1,
        id: newEventId(),
        ts: new Date().toISOString(),
        session: this.meta.id,
        parent: this.meta.parent,
        forkedAtSeq: this.meta.forkedAtSeq,
        type,
        data,
      };
      const line = JSON.stringify(e) + '\n';
      const fd = fs.openSync(this.eventsFile, 'a', 0o600);
      try {
        fs.writeFileSync(fd, line);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this._seq = e.seq;
      events.push(e as Event);
      this.cache = events;
      this.validBytes += Buffer.byteLength(line);
      this.cacheBytes = this.validBytes;
      this.meta.updatedAt = e.ts;
      this.saveMeta();
      this.onAppend?.(e as Event);
      return e;
    } finally { release(); }
  }

  /** One local writer per session, held across a whole turn. Dead PID locks are reclaimed. */
  lock(): () => void {
    if (this.locked) throw new Error(`会话 ${this.id} 已在执行中`);
    const lockFile = path.join(this.dir, 'writer.lock');
    const claim = path.join(this.dir, `writer-${process.pid}-${newEventId()}.lock`);
    fs.writeFileSync(claim, `${process.pid}-${newEventId()}`, { flag: 'wx', mode: 0o600 });
    const ownerOf = (file: string): string | null => {
      try { return fs.readFileSync(file, 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    };
    const acquire = (file: string): void => {
      for (;;) {
        try { fs.linkSync(claim, file); return; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        const owner = ownerOf(file);
        if (owner === null) continue;
        // Accept old PID-only locks too. A unique generation prevents deleting a successor's lock.
        if (!/^\d+(?:-[0-9a-f-]{36})?$/.test(owner)) throw new Error('会话写锁损坏');
        const pid = Number(owner.split('-')[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('会话写锁损坏');
        try { process.kill(pid, 0); throw new Error(`会话 ${this.id} 已被进程 ${pid} 锁定`); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        // Recovery claims use the same protocol, so a crash during takeover is recoverable too.
        const recovery = path.join(this.dir, `writer-recovery-${owner}.lock`);
        acquire(recovery);
        try {
          if (ownerOf(file) === owner) fs.unlinkSync(file);
        } finally { fs.unlinkSync(recovery); }
      }
    };
    try {
      acquire(lockFile);
    } finally { fs.unlinkSync(claim); }
    this.locked = true;
    this.cache = null;
    return () => { fs.unlinkSync(lockFile); this.locked = false; };
  }

  /** fork/open 场景：把写入游标定位到既有事件流的尾部 */
  resumeFrom(seq: number): void {
    this._seq = seq;
  }

  /** fork 用：整体写入一段事件前缀（session 字段由调用方改写为目标会话） */
  importPrefix(events: Event[]): void {
    fs.writeFileSync(this.eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    this._seq = events.length ? events[events.length - 1]!.seq : 0;
    this.cache = null;
  }

  /** 返回缓存引用——调用方不得原地修改（fold 是只读遍历） */
  readAll(): Event[] {
    const bytes = fs.existsSync(this.eventsFile) ? fs.statSync(this.eventsFile).size : 0;
    if (this.cache && this.cacheBytes === bytes) return this.cache;
    const out: Event[] = [];
    this.validBytes = 0;
    if (fs.existsSync(this.eventsFile)) {
      const raw = fs.readFileSync(this.eventsFile, 'utf8');
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        try {
          const event = JSON.parse(line) as Event;
          if (event.seq !== out.length + 1 || event.session !== this.id || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') throw new Error('非法事件');
          out.push(event);
          this.validBytes += Buffer.byteLength(line) + 1;
        } catch (e) {
          throw new Error(`事件流损坏，第 ${i + 1} 行: ${(e as Error).message}`);
        }
      }
      // Only an unterminated tail is uncommitted; preserve it before the next append.
    }
    this.cache = out;
    this.cacheBytes = bytes;
    return out;
  }

  blobDir(): string {
    const d = path.join(this.dir, 'blobs');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  /** 内容寻址的文件快照（检查点），返回 sha256；同内容只存一份 */
  putBlob(content: Buffer): string {
    const sha = createHash('sha256').update(content).digest('hex');
    const file = path.join(this.blobDir(), sha);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${newEventId()}.tmp`;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return sha;
  }

  getBlob(sha: string): Buffer {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('非法快照 id');
    return fs.readFileSync(path.join(this.blobDir(), sha));
  }

  evidenceDir(): string {
    const d = path.join(this.dir, 'evidence');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  setTitle(title: string): void {
    if (!this.meta.title && title) {
      this.meta.title = title;
      this.saveMeta();
    }
  }

  saveMeta(): void {
    const file = path.join(this.dir, `meta-${newEventId()}.tmp`);
    fs.writeFileSync(file, JSON.stringify(this.meta, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(file, path.join(this.dir, 'meta.json'));
  }
}
