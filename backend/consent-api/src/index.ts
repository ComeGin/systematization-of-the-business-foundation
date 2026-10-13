import { loadConfig } from "./config.js";
import { SERVER_NAME, SHUTDOWN_TIMEOUT_MS } from "./constants.js";
import { createHandler } from "./handler.js";
import { createServer } from "./server.js";
import { ConsentStore } from "./store.js";
import { createValkey } from "./valkey.js";

// 開発の入口（pnpm dev・compose）。本番は lambda.ts
const config = loadConfig();
const valkey = createValkey(config);
const server = createServer(createHandler({ config, store: new ConsentStore(valkey, config.VALKEY_KEY_PREFIX) }));

server.listen(config.PORT, config.HOST, () => {
  console.error(`[${SERVER_NAME}] listening on ${config.HOST}:${config.PORT}`);
});

// 停止（SIGTERM・SIGINT）では、処理中のリクエストを終えてから Valkey を閉じる（開発だけ。Lambda では要らない）
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${SERVER_NAME}] ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  server.close(() => {
    valkey.quit().catch(() => valkey.disconnect()).finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
