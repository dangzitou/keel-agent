import { randomUUID, randomBytes } from 'node:crypto';

/** 事件 id */
export function newEventId(): string {
  return randomUUID();
}

/** 会话 id：可读的时间戳 + 随机后缀，如 20260914-153000-a1b2c3 */
export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}
