import pg from "pg";
import type { Config } from "./config.js";
import { DB_CONNECT_TIMEOUT_MS, DB_POOL_MAX } from "./constants.js";

/** overrides は入口ごとの調整（Lambda の入口がプールの上限と問い合わせのタイムアウトを渡す。lambda.ts） */
export function createPool(config: Config, overrides: { max?: number; queryTimeoutMs?: number } = {}): pg.Pool {
  const pool = new pg.Pool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_NAME,
    user: config.DATABASE_USERNAME,
    password: config.DATABASE_PASSWORD,
    // 有効にしたときは証明書を検証する（本番の Lambda は NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem で RDS の CA を信頼させる）
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: overrides.max ?? DB_POOL_MAX,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    ...(overrides.queryTimeoutMs === undefined ? {} : { query_timeout: overrides.queryTimeoutMs }),
  });
  // アイドル接続が切れたときに未処理のエラーでプロセスが落ちないようにする
  pool.on("error", (error) => {
    console.error(`[db] ${error.message}`);
  });
  return pool;
}
