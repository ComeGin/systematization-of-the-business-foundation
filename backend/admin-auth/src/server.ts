import http from "node:http";
import { toNodeHandler } from "better-auth/node";
import { HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { Handle } from "./handler.js";

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/**
 * 開発の入口（3103。仕様 3.1）。toNodeHandler が Node の要求を Request にして handle を呼び、Response を書き出す
 * （複数の Set-Cookie も 1 つずつ書く）。本番は lambda.ts（ALB のターゲット）で、keep-alive などは開発だけの意味になる
 */
export function createServer(handle: Handle): http.Server {
  const nodeHandler = toNodeHandler(handle);
  const server = http.createServer((req, res) => {
    // 解釈できない要求ターゲット（例 //[）は、toNodeHandler の new Request が投げる前に 400 にする（以前の index.ts と同じ）
    if (!URL.parse(req.url ?? "/", "http://localhost")) {
      sendText(res, 400, "bad request");
      console.error(
        JSON.stringify({ t: new Date().toISOString(), method: req.method, path: (req.url ?? "").split("?")[0], status: 400, ms: 0 }),
      );
      return;
    }
    nodeHandler(req, res).catch((error: unknown) => {
      // handle は例外を投げない約束。投げたら詳細を出さずに 500 にする
      console.error("[server] unexpected error", error);
      if (!res.headersSent) sendText(res, 500, "internal error");
      else res.end();
    });
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
