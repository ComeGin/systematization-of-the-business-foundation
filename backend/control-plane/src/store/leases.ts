import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.js";

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LeaseRow {
  lease_key: string;
  run_id: string;
  pid: number;
  expires_at: number;
}

/**
 * 実行中の印。リース時間（expires_at）を過ぎるか、持ち主のプロセスが死んでいれば奪える。
 * 「前回が実行中なら起動を見送る」判定はここで原子的に行う。
 */
export class LeaseStore {
  constructor(private readonly db: DatabaseSync) {}

  acquire(key: string, runId: string, ttlMs: number, now: number = Date.now()): boolean {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT lease_key, run_id, pid, expires_at FROM leases WHERE lease_key = ?")
        .get(key) as LeaseRow | undefined;
      if (row && row.expires_at > now && pidAlive(row.pid)) return false;
      this.db
        .prepare(
          `INSERT INTO leases (lease_key, run_id, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (lease_key) DO UPDATE SET run_id = excluded.run_id, pid = excluded.pid,
             acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        )
        .run(key, runId, process.pid, now, now + ttlMs);
      return true;
    });
  }

  release(key: string, runId: string): void {
    this.db.prepare("DELETE FROM leases WHERE lease_key = ? AND run_id = ?").run(key, runId);
  }

  /** run を持ち主とするリースが、まだ他のプロセスで有効か（起動時の中断判定に使う）。 */
  heldElsewhere(runId: string, now: number = Date.now()): boolean {
    const row = this.db.prepare("SELECT pid, expires_at FROM leases WHERE run_id = ?").get(runId) as
      | { pid: number; expires_at: number }
      | undefined;
    return row !== undefined && row.pid !== process.pid && row.expires_at > now && pidAlive(row.pid);
  }

  releaseByRun(runId: string): void {
    this.db.prepare("DELETE FROM leases WHERE run_id = ?").run(runId);
  }
}
