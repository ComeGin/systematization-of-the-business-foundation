import { Redis, type RedisOptions } from "ioredis";
import type { Config } from "./config.js";
import { VALKEY_COMMAND_TIMEOUT_MS, VALKEY_CONNECT_TIMEOUT_MS } from "./constants.js";

// Valkey が落ちている間、再接続のたびに同じエラーが出続けるため、ログは一定間隔にまとめる
const ERROR_LOG_INTERVAL_MS = 30_000;

/** extra は入口ごとの追加の設定（Lambda の入口が socketTimeout を渡す。lambda.ts） */
export function createValkey(config: Config, extra: Pick<RedisOptions, "socketTimeout"> = {}): Redis {
  const client = new Redis(config.VALKEY_URL, {
    password: config.VALKEY_PASSWORD,
    connectTimeout: VALKEY_CONNECT_TIMEOUT_MS,
    commandTimeout: VALKEY_COMMAND_TIMEOUT_MS,
    // 接続できないときにコマンドを溜めず、すぐ失敗させる（API は 503 を返す）
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    ...extra,
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

/**
 * 接続が ready になるのを待つ（Lambda の入口が使う。仕様 3.3）。enableOfflineQueue: false のため、
 * ready の前に送ったコマンドはすぐ失敗する。すでに ready なら待たない。時間切れなら false（例外にしない）
 */
export function waitReady(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === "ready") return Promise.resolve(true);
  return new Promise((resolve) => {
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      resolve(false);
    }, timeoutMs);
    client.once("ready", onReady);
  });
}
