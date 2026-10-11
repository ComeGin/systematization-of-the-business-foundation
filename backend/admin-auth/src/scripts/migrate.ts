import { getMigrations } from "better-auth/db/migration";
import { ensureAllowlistTable } from "../allowlist.js";
import { createAuthOptions } from "../auth.js";
import { loadConfig } from "../config.js";
import { createPool } from "../db.js";

// Better Auth のスキーマ（ユーザー・セッション・OAuth クライアント・JWKS など）と、許可リストの表を作る。
// 何度実行しても安全（不足を足すだけ）。本番では SAM の「DB の移行を 1 回だけ行うタスク」から
// `node dist/scripts/migrate.js` として実行する（TA-06 の 3.3）
const config = loadConfig();
const pool = createPool(config);

try {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(createAuthOptions(config, pool));
  console.error(
    `[migrate] create tables: ${toBeCreated.map((t) => t.table).join(", ") || "-"} / add columns: ${toBeAdded.map((t) => t.table).join(", ") || "-"}`,
  );
  await runMigrations();
  await ensureAllowlistTable(pool);
  console.error("[migrate] done");
} catch (error) {
  console.error(`[migrate] failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
