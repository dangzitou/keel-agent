/** LLM 调用重试：仅对瞬态错误（429/5xx/网络）退避重试；4xx 参数类错误立即抛出。 */

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function isRetryable(e: unknown): boolean {
  const err = e as { status?: number; noRetry?: boolean; message?: string };
  if (err?.noRetry) return false;
  if (err?.status && RETRYABLE_STATUS.has(err.status)) return true;
  return /无法连接|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|terminated/i.test(
    err?.message ?? '',
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export interface RetryOpts {
  /** 总尝试次数 = retries + 1 */
  retries: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  onRetry?: (failedAttempt: number, error: Error, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOpts,
): Promise<{ result: T; attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (e) {
      const err = e as Error & { retryAfterMs?: number };
      if (opts.signal?.aborted || attempt > opts.retries || !isRetryable(e)) throw e;
      let delay = Math.min(30_000, (opts.baseDelayMs ?? 800) * 2 ** (attempt - 1));
      if (err.retryAfterMs && err.retryAfterMs > 0) delay = Math.min(60_000, err.retryAfterMs);
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay, opts.signal);
    }
  }
}
