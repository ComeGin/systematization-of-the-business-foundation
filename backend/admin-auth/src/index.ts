import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { AUTH_BASE_PATH, SERVER_NAME, SHUTDOWN_TIMEOUT_MS } from "./constants.js";
import { createPool } from "./db.js";
import { createHandler } from "./handler.js";
import { createServer } from "./server.js";

// 開発の入口（pnpm dev・compose）。本番は lambda.ts（本体）と ops.ts（運用）。
// 許可リストの初期値は追加しない（migrate の最後で追加する。仕様 3.5）。表が無いあいだはログインの判定が 500 になる
const config = loadConfig();
const pool = createPool(config);
const server = createServer(createHandler({ auth: createAuth(config, pool) }));

server.listen(config.PORT, config.HOST, () => {
  console.error(`[${SERVER_NAME}] listening on ${config.HOST}:${config.PORT} (issuer ${config.BETTER_AUTH_URL}${AUTH_BASE_PATH})`);
});

// 停止（SIGTERM・SIGINT）では、処理中のリクエストを終えてから DB を閉じる（開発だけ。Lambda では要らない）
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${SERVER_NAME}] ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
