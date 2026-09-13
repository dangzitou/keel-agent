import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isRetryable } from '../src/llm/retry.js';

function httpErr(status: number): Error & { status: number } {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

test('重试: 瞬态错误后成功，onRetry 逐次回调', async () => {
  const failures: (number | undefined)[] = [500, 429, undefined];
  let calls = 0;
  const retries: number[] = [];
  const { result, attempts } = await withRetry(
    async () => {
      const st = failures[calls++];
      if (st) throw httpErr(st);
      return 'ok';
    },
    { retries: 3, baseDelayMs: 1, onRetry: (a) => retries.push(a) },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [1, 2]);
});

test('重试: 参数类错误（4xx）不重试直接抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw httpErr(401);
      },
      { retries: 5, baseDelayMs: 1 },
    ),
    /HTTP 401/,
  );
  assert.equal(calls, 1);
});

test('重试: 次数耗尽后抛出最后一次错误', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw httpErr(503);
      },
      { retries: 2, baseDelayMs: 1 },
    ),
  );
  assert.equal(calls, 3);
});

test('重试: Retry-After 优先于指数退避', async () => {
  let delayUsed = 0;
  const e = httpErr(429);
  (e as unknown as { retryAfterMs: number }).retryAfterMs = 1234;
  void withRetry(
    async () => {
      throw e;
    },
    {
      retries: 1,
      baseDelayMs: 1,
      onRetry: (_a, _e, d) => {
        delayUsed = d;
      },
    },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(delayUsed, 1234);
});

test('isRetryable: 网络类错误识别', () => {
  assert.ok(isRetryable(new Error('无法连接 https://x: fetch failed')));
  assert.ok(isRetryable(new Error('socket hang up')));
  assert.ok(!isRetryable(new Error('HTTP 400: bad request')));
  assert.ok(!isRetryable(Object.assign(new Error('x'), { noRetry: true, status: 500 })));
});
