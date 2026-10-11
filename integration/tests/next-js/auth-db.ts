// 監視アプリの Better Auth の DB（CONTROL_DATA_DIR/auth.sqlite。作業ツリーの外）を、後片付けのためだけに開く。
// ソーシャルログインの開始が作る state の行（verification）を消す。ほかの表には触れない。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { confValues } from "../helpers/env.ts";

/** control-plane の resolveDataDir と同じ規則（空なら ~/.local/share/comegin-control） */
export function authDatabasePath(): string {
  const raw = confValues().CONTROL_DATA_DIR?.trim();
  const dir = raw ? raw.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".local/share/comegin-control");
  return join(dir, "auth.sqlite");
}

/** state の行を消す。DB が無い・行が無いときは例外（後片付けの失敗として残す） */
export function deleteVerification(identifier: string): void {
  const path = authDatabasePath();
  if (!existsSync(path)) throw new Error(`監視アプリの認証 DB が無い: ${path}`);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const { changes } = db.prepare("DELETE FROM verification WHERE identifier = ?").run(identifier);
    if (Number(changes) !== 1) throw new Error(`state の行が見つからない（${path}。監視アプリの CONTROL_DATA_DIR が別の場所かもしれない）`);
  } finally {
    db.close();
  }
}
