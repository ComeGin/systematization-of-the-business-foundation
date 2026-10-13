import { createAuthOptions } from "../auth.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { runMigrate } from "../operations.js";

// 開発の CLI（pnpm db:migrate・compose の migrate サービス）。本番は運用の Lambda（ops.ts）の {"action":"migrate"}。
// Better Auth のスキーマと許可リストの表を作り、許可リストの初期値（ADMIN_BOOTSTRAP_EMAILS）を追加する。何度実行しても安全
const config = loadConfig();
const pool = createPool(config);

try {
  await runMigrate(pool, createAuthOptions(config, pool), config.ADMIN_BOOTSTRAP_EMAILS);
  console.error("[migrate] done");
} catch (error) {
  console.error(`[migrate] failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
