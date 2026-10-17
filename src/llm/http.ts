import { ChatMessage } from './types.js';

/** 组合外部中断与超时 */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function httpError(status: number, body: string, retryAfterHeader: string | null): Error & { status: number; retryAfterMs?: number } {
  const e = new Error(`LLM 请求失败 HTTP ${status}: ${body.slice(0, 500)}`) as Error & { status: number; retryAfterMs?: number };
  e.status = status;
  const seconds = Number(retryAfterHeader);
  const ra = retryAfterHeader ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfterHeader) - Date.now()) : NaN;
  if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = ra;
  return e;
}

/** 三种协议共用的 POST：统一中断语义（用户主动中断标记 noRetry）与 HTTP 错误包装 */
export async function postJson(url: string, init: { headers: Record<string, string>; body: unknown; signal?: AbortSignal; timeoutMs?: number }): Promise<Response> {
  let res: Response;
  const signal = requestSignal(init.signal, init.timeoutMs ?? 600_000);
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: JSON.stringify(init.body),
      signal,
    });
  } catch (e) {
    if (init.signal?.aborted) {
      const err = new Error(`请求被中断: ${(e as Error).message}`) as Error & { noRetry: boolean };
      err.noRetry = true;
      throw err;
    }
    throw new Error(`无法连接 ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let safeText = text;
    for (const header of ['authorization', 'x-api-key']) {
      const key = init.headers[header]?.replace(/^Bearer /i, '');
      if (key) safeText = safeText.replaceAll(key, '[redacted]');
    }
    throw httpError(res.status, safeText, res.headers.get('retry-after'));
  }
  return res;
}

export async function responseJson(res: Response): Promise<any> {
  return res.json();
}

/** SSE data frames: CRLF, multiline data and a final unterminated frame are supported. */
export async function* sseDataChunks(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error('流式响应缺少 body');
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  for await (const raw of res.body) {
    buf += decoder.decode(raw as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line === '') {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  buf += decoder.decode();
  if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, '').replace(/\r$/, ''));
  if (data.length) yield data.join('\n');
}

/** usage 兜底估算：服务未回传 usage 时按字符估（与 OpenAI 兼容层同一套口径） */
export function estimateUsage(messages: ChatMessage[], message: { content: string | null; tool_calls: { function: { arguments: string } }[] }): { inputTokens: number; outputTokens: number } {
  const inputChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  const outputChars = (message.content?.length ?? 0) + message.tool_calls.reduce((n, tc) => n + tc.function.arguments.length, 0);
  return { inputTokens: Math.ceil(inputChars / 3), outputTokens: Math.ceil(outputChars / 3) };
}
