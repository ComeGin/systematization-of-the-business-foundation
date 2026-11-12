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
  // 改善ループ（14 日の周・周の項目・人の承認の記録）
  `
  CREATE TABLE cycles (
    cycle_id TEXT PRIMARY KEY,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    close_json TEXT
  );

  CREATE TABLE cycle_items (
    item_id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('article', 'campaign', 'code', 'deploy', 'proposal', 'manual')),
    stage TEXT NOT NULL CHECK (stage IN ('collect', 'propose', 'draft', 'review', 'publish', 'evaluate', 'deploy')),
    source_ref TEXT NOT NULL,
    proposal_id TEXT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    preview_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preparing', 'awaiting_review', 'approved', 'executed', 'confirmed', 'rejected', 'failed_check')),
    state_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reflected_at TEXT,
    UNIQUE (kind, source_ref)
  );
  CREATE INDEX cycle_items_cycle ON cycle_items (cycle_id, item_id);

  CREATE TABLE cycle_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'execute')),
    actor TEXT NOT NULL,
    checked_json TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX cycle_approvals_item ON cycle_approvals (item_id, id);
  `,
  // 2026-11-12: 実行モデルの選択（監視アプリの画面）と変更の履歴、実行に使ったモデル
  `
  CREATE TABLE model_settings (
    scope TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    actor TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE model_setting_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    model TEXT,
    previous TEXT,
    actor TEXT NOT NULL,
    at TEXT NOT NULL
  );

  ALTER TABLE runs ADD COLUMN model TEXT;
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
