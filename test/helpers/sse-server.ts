import http from 'node:http';

export type SseHandler = (
  reqIndex: number,
  body: string,
  res: http.ServerResponse,
  req: http.IncomingMessage,
) => void;

export interface SseServer {
  /** 形如 http://127.0.0.1:<port>/v1，可直接作 provider baseURL */
  url: string;
  requestCount(): number;
  close(): Promise<void>;
}

/** 本地 SSE mock 服务器：ephemeral 端口，按请求序号分派 handler */
export function startSseServer(handler: SseHandler): Promise<SseServer> {
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => handler(count++, body, res, req));
    req.on('error', () => {
      /* 客户端中断（如 SIGINT 测试）导致 socket 销毁，忽略 */
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        requestCount: () => count,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

export function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

/** 按 10ms 间隔逐块写 SSE：保证客户端的 for-await 循环真正收到"分片到达"，而不是一次读全 */
export function sendSse(res: http.ServerResponse, parts: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let i = 0;
  const timer = setInterval(() => {
    if (i < parts.length) {
      res.write(parts[i++]);
    } else {
      clearInterval(timer);
      res.end();
    }
  }, 10);
}
