import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
}

export interface RequestOptions {
  method?: string;
  path?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
  /** Content-Length を付けずにチャンクで送る */
  chunked?: boolean;
  /** ヘッダーだけ送って本文を送らない（宣言した Content-Length で弾かれるかを見る） */
  headersOnly?: boolean;
}

/** 127.0.0.1 のポート 0 で起動する。外部には出ない */
export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * fetch ではなく node:http で送る（Origin・Cookie・Content-Length をそのまま送り、
 * 自動で足されるヘッダーを避けるため）。keep-alive のプールは使わない
 */
export function request(baseUrl: string, options: RequestOptions = {}): Promise<TestResponse> {
  const url = new URL(options.path ?? "/v1/consent", baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          if (options.headersOnly) req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (options.headersOnly) {
      req.flushHeaders();
      return;
    }
    if (options.body !== undefined) {
      if (options.chunked) {
        req.setHeader("Transfer-Encoding", "chunked");
      } else if (!req.hasHeader("Content-Length")) {
        req.setHeader("Content-Length", Buffer.byteLength(options.body));
      }
      req.write(options.body);
    }
    req.end();
  });
}
