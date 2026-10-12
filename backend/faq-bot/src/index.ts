import { loadConfig } from "./config.js";
import { SERVER_NAME, SHUTDOWN_TIMEOUT_MS } from "./constants.js";
import { createRuntime } from "./runtime.js";
import { createDevServer } from "./server.js";

// 開発の入口（pnpm dev）。本番は lambda.ts
const config = loadConfig();
const server = createDevServer(createRuntime(config).handle);

server.listen(config.PORT, config.HOST, () => {
  console.error(`[${SERVER_NAME}] listening on ${config.HOST}:${config.PORT}（FAQ: ${config.FAQ_URL}）`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${SERVER_NAME}] ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
