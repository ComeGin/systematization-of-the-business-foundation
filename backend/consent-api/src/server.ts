import http from "node:http";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { Handle } from "./handler.js";

interface ReadBody {
  body: Buffer;
  /** 最後まで読んだか。読み残しがあれば、応答に Connection: close を付けて接続を閉じる */
  complete: boolean;
}

/**
 * 本文を上限 + 1 バイトまで読む（判定は handler が行う）。宣言された長さが上限を超えていれば読まない。
 * 接続が途中で切れたら例外になる
 */
async function readBody(req: http.IncomingMessage): Promise<ReadBody> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { body: Buffer.alloc(0), complete: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    chunks.push(buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { body: Buffer.concat(chunks), complete: false };
  }
  return { body: Buffer.concat(chunks), complete: true };
}

/**
 * 開発の入口（3104。仕様 3.1）。要求を HttpRequest に詰めて handle を呼び、結果を書き出すだけ。
 * 本番は lambda.ts（ALB のターゲット）で、keep-alive などの設定は開発だけの意味になる
 */
export function createServer(handle: Handle): http.Server {
  const server = http.createServer(async (req, res) => {
    let read: ReadBody;
    try {
      read = await readBody(req);
    } catch {
      // 本文の途中で接続が切れた。記録しない
      res.destroy();
      return;
    }
    try {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const result = await handle({ method: req.method ?? "GET", path: req.url ?? "/", headers, body: read.body });
      res.writeHead(result.status, read.complete ? result.headers : { ...result.headers, Connection: "close" });
      res.end(result.body);
    } catch (error) {
      // handle は例外を投げない約束。投げたら詳細を出さずに 500 にする
      console.error("[server] unexpected error", error);
      if (res.headersSent) return void res.end();
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify({ error: "internal" }));
    }
  });

  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
