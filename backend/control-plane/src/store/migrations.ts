import type { DatabaseSync } from "node:sqlite";

// PRAGMA user_version を版番号として使う。追加は末尾に足すだけで、既存の要素は書き換えない。
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    job_id TEXT,
    agent_name TEXT,
    builtin TEXT,
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'manual', 'proposal')),
    status TEXT NOT NULL CHECK (status IN ('running', 'finished')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'failure', 'partial', 'skipped')),
    summary TEXT,
    summary_redacted INTEGER NOT NULL DEFAULT 0,
    target_ids TEXT NOT NULL DEFAULT '[]',
    skip_reason TEXT,
    failure_class TEXT,
    sdk_subtype TEXT,
    cost_usd REAL,
    copied_at TEXT,
    snapshot_json TEXT
  );
  CREATE INDEX runs_job_id ON runs (job_id, run_id);
  CREATE INDEX runs_started_at ON runs (started_at);
  CREATE INDEX runs_uncopied ON runs (run_id) WHERE status = 'finished' AND copied_at IS NULL;

  CREATE TABLE leases (
    lease_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE miswrite_candidates (
    message_id INTEGER PRIMARY KEY,
    conversation_display_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    nearest_run_id TEXT,
    reason TEXT NOT NULL,
    found_at TEXT NOT NULL
  );
  CREATE INDEX miswrite_found_at ON miswrite_candidates (found_at);
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`E-15 のスキーマ版（${current}）がこのコードより新しい（${MIGRATIONS.length}）`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
