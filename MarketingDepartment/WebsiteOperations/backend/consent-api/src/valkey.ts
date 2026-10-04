import { Redis } from "ioredis";
import type { Config } from "./config.js";
import { VALKEY_COMMAND_TIMEOUT_MS, VALKEY_CONNECT_TIMEOUT_MS } from "./constants.js";

// Valkey が落ちている間、再接続のたびに同じエラーが出続けるため、ログは一定間隔にまとめる
const ERROR_LOG_INTERVAL_MS = 30_000;

export function createValkey(config: Config): Redis {
  const client = new Redis(config.VALKEY_URL, {
    password: config.VALKEY_PASSWORD,
    connectTimeout: VALKEY_CONNECT_TIMEOUT_MS,
    commandTimeout: VALKEY_COMMAND_TIMEOUT_MS,
    // 接続できないときにコマンドを溜めず、すぐ失敗させる（API は 503 を返す）
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  let lastLoggedAt = 0;
  client.on("error", (error) => {
    const now = Date.now();
    if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) return;
    lastLoggedAt = now;
    console.error(`[valkey] ${error.message}`);
  });

  return client;
}
