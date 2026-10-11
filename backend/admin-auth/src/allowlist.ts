import type pg from "pg";
import { ALLOWLIST_TABLE } from "./constants.js";

// 認可（誰を管理画面に通すか）は Workspace のアカウントを持つことと別。許可リストの表だけが決める。
// 追加と削除は人が SQL で行う（README）。ADMIN_BOOTSTRAP_EMAILS は起動時に追加するだけで、削除はしない

export async function ensureAllowlistTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ALLOWLIST_TABLE} (
      email    text PRIMARY KEY CHECK (email = lower(email)),
      added_at timestamptz NOT NULL DEFAULT now(),
      added_by text NOT NULL DEFAULT 'manual'
    )
  `);
}

/** 初期値を表へ追加する。すでにあるメールには触れない。追加した件数を返す */
export async function bootstrapAllowlist(pool: pg.Pool, emails: string[]): Promise<number> {
  if (emails.length === 0) return 0;
  const result = await pool.query(
    `INSERT INTO ${ALLOWLIST_TABLE} (email, added_by)
     SELECT unnest($1::text[]), 'bootstrap'
     ON CONFLICT (email) DO NOTHING`,
    [emails.map((email) => email.toLowerCase())],
  );
  return result.rowCount ?? 0;
}

export async function isAllowlisted(pool: pg.Pool, email: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM ${ALLOWLIST_TABLE} WHERE email = $1`, [email.toLowerCase()]);
  return (result.rowCount ?? 0) > 0;
}

/** Better Auth のユーザーの表（既定のモデル名 user）からメールを引く */
export async function findUserEmail(pool: pg.Pool, userId: string): Promise<string | null> {
  const result = await pool.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [userId]);
  return result.rows[0]?.email ?? null;
}
