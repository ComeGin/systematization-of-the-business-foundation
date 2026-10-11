import pg from "pg";
import type { Config } from "./config.js";
import { DB_CONNECT_TIMEOUT_MS, DB_POOL_MAX } from "./constants.js";

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USERNAME,
    password: config.DATABASE_PASSWORD,
    // 有効にしたときは証明書を検証する（RDS の CA は NODE_EXTRA_CA_CERTS で信頼させる）
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  });
  // アイドル接続が切れたときに未処理のエラーでプロセスが落ちないようにする
  pool.on("error", (error) => {
    console.error(`[db] ${error.message}`);
  });
  return pool;
}
