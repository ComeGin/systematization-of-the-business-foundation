import type { DatabaseSync } from "node:sqlite";
import { toIsoJst } from "../time.js";

/** 突き合わせの前回完了時刻など、小さな状態の置き場。 */
export class KvStore {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, toIsoJst());
  }
}
