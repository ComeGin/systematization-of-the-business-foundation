import http from "node:http";
import { MAX_BODY_BYTES, REQUEST_TIMEOUT_MS, SERVER_NAME } from "./constants.js";
import type { Handle } from "./handler.js";

/** 開発の入口（3107）。要求を HttpRequest に変えて handle を呼ぶ。例外は本番の関数 URL と同じく 502 にする（仕様 8 節） */
export function createDevServer(handle: Handle, log: (message: string) => void = (message) => console.error(message)): http.Server {
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    };
    try {
      // 上限を超えた分は捨てながら最後まで読む（途中で応答すると、送信中のクライアントの接続が切れて失敗する）
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
      }
      if (size > MAX_BODY_BYTES) return send(413, JSON.stringify({ error: "payload_too_large" }));
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      const result = await handle({ method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0] || "/", headers, body: Buffer.concat(chunks) });
      send(result.status, result.body);
    } catch (error) {
      log(`[${SERVER_NAME}] 処理に失敗した: ${(error as Error).name}: ${(error as Error).message}`);
      if (!res.headersSent) send(502, JSON.stringify({ error: "bad_gateway" }));
      else res.end();
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
