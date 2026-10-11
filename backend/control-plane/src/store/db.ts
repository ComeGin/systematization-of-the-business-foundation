import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

export const E15_DB_FILENAME = "e15.sqlite";
export const AUTH_DB_FILENAME = "auth.sqlite";

/** E-15 の SQLite を開く。置き場は作業ツリーの外（エージェントのファイル操作の届かない場所）。 */
export function openE15Database(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const file = join(dataDir, E15_DB_FILENAME);
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

/**
 * 監視アプリのログイン（Better Auth）用の SQLite。E-15 とは別のファイル。
 * node:sqlite を監視アプリのバンドルに入れないよう、開く処理はここに置いて、ハンドルだけを渡す。
 */
export function openAuthDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const file = join(dataDir, AUTH_DB_FILENAME);
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** BEGIN IMMEDIATE で書き込みの競合を先に取る。 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
