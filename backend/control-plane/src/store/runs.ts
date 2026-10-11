import type { DatabaseSync } from "node:sqlite";
import type { BuiltinJob, FailureClass, ListRunsQuery, RunOutcome, RunRecord, RunTrigger } from "../contract.js";

interface RunRow {
  run_id: string;
  job_id: string | null;
  agent_name: string | null;
  builtin: string | null;
  trigger_kind: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  summary: string | null;
  summary_redacted: number;
  target_ids: string;
  skip_reason: string | null;
  failure_class: string | null;
  sdk_subtype: string | null;
  cost_usd: number | null;
  copied_at: string | null;
}

const COLUMNS = `run_id, job_id, agent_name, builtin, trigger_kind, status, started_at, finished_at, outcome,
  summary, summary_redacted, target_ids, skip_reason, failure_class, sdk_subtype, cost_usd, copied_at`;

function toRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    agentName: row.agent_name,
    builtin: row.builtin as BuiltinJob | null,
    trigger: row.trigger_kind as RunTrigger,
    status: row.status as RunRecord["status"],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as RunOutcome | null,
    summary: row.summary,
    summaryRedacted: row.summary_redacted === 1,
    targetIds: JSON.parse(row.target_ids) as string[],
    skipReason: row.skip_reason,
    failureClass: row.failure_class as FailureClass | null,
    sdkSubtype: row.sdk_subtype,
    costUsd: row.cost_usd,
    copiedAt: row.copied_at,
  };
}

export interface NewRun {
  runId: string;
  jobId: string | null;
  agentName: string | null;
  builtin: BuiltinJob | null;
  trigger: RunTrigger;
  startedAt: string;
}

/** 実行の終了時に確定する項目。summary は PII 検査を通した後の値を渡す。 */
export interface RunFinish {
  finishedAt: string;
  outcome: RunOutcome;
  summary: string | null;
  summaryRedacted: boolean;
  targetIds: string[];
  skipReason: string | null;
  failureClass: FailureClass | null;
  sdkSubtype: string | null;
  costUsd: number | null;
}

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/** E-15 AgentRun の読み書き。書くのは監視アプリのサーバー側だけ（エージェントには書かせない）。 */
export class RunStore {
  constructor(private readonly db: DatabaseSync) {}

  insertRunning(run: NewRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, job_id, agent_name, builtin, trigger_kind, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(run.runId, run.jobId, run.agentName, run.builtin, run.trigger, run.startedAt);
  }

  /**
   * 実行の終了を確定し、S3 への写しに使う snapshot_json も同時に固める（再送でも中身が変わらない）。
   * 確定済みの run は上書きせず、DB にある記録（1 回目の内容）をそのまま返す。
   */
  finish(runId: string, result: RunFinish): RunRecord {
    const current = this.get(runId);
    if (!current) throw new Error(`run が存在しない: ${runId}`);
    const finished: RunRecord = {
      ...current,
      status: "finished",
      finishedAt: result.finishedAt,
      outcome: result.outcome,
      summary: result.summary,
      summaryRedacted: result.summaryRedacted,
      targetIds: result.targetIds,
      skipReason: result.skipReason,
      failureClass: result.failureClass,
      sdkSubtype: result.sdkSubtype,
      costUsd: result.costUsd,
      copiedAt: null,
    };
    const updated = this.db
      .prepare(
        `UPDATE runs SET status = 'finished', finished_at = ?, outcome = ?, summary = ?, summary_redacted = ?,
           target_ids = ?, skip_reason = ?, failure_class = ?, sdk_subtype = ?, cost_usd = ?, snapshot_json = ?
         WHERE run_id = ? AND status = 'running'`,
      )
      .run(
        result.finishedAt,
        result.outcome,
        result.summary,
        result.summaryRedacted ? 1 : 0,
        JSON.stringify(result.targetIds),
        result.skipReason,
        result.failureClass,
        result.sdkSubtype,
        result.costUsd,
        JSON.stringify(finished),
        runId,
      );
    // 0 件 = 既に確定済み（status が running でない）。引数で組み立てた記録は DB と食い違うので返さない
    if (Number(updated.changes) === 0) return this.get(runId) ?? current;
    return finished;
  }

  get(runId: string): RunRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(query: ListRunsQuery = {}): RunRecord[] {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.before) {
      where.push("run_id < ?");
      params.push(query.before);
    }
    if (query.jobId) {
      where.push("job_id = ?");
      params.push(query.jobId);
    }
    if (query.outcome) {
      where.push("outcome = ?");
      params.push(query.outcome);
    }
    const sql = `SELECT ${COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY run_id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as unknown as RunRow[]).map(toRecord);
  }

  /** 指定時刻（ISO 8601）以降に開始した run を古い順に返す。 */
  startedSince(sinceIso: string): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE started_at >= ? ORDER BY run_id ASC`)
      .all(sinceIso) as unknown as RunRow[];
    return rows.map(toRecord);
  }

  latestByJob(jobId: string): RunRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE job_id = ? ORDER BY run_id DESC LIMIT 1`)
      .get(jobId) as RunRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** after の判定: 指定時刻以降に success で終わった run があるか。 */
  hasSuccessSince(jobId: string, sinceIso: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM runs WHERE job_id = ? AND outcome = 'success' AND started_at >= ? LIMIT 1`)
      .get(jobId, sinceIso);
    return row !== undefined;
  }

  running(): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE status = 'running' ORDER BY run_id ASC`)
      .all() as unknown as RunRow[];
    return rows.map(toRecord);
  }

  /** S3 への写しが未送の run（古い順）。 */
  pendingCopies(limit: number): { runId: string; startedAt: string; snapshot: string }[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, started_at, snapshot_json FROM runs
         WHERE status = 'finished' AND copied_at IS NULL AND snapshot_json IS NOT NULL
         ORDER BY run_id ASC LIMIT ?`,
      )
      .all(limit) as unknown as { run_id: string; started_at: string; snapshot_json: string }[];
    return rows.map((row) => ({ runId: row.run_id, startedAt: row.started_at, snapshot: row.snapshot_json }));
  }

  markCopied(runId: string, copiedAt: string): void {
    this.db.prepare("UPDATE runs SET copied_at = ? WHERE run_id = ? AND copied_at IS NULL").run(copiedAt, runId);
  }
}
