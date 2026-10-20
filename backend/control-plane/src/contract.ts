// control-plane と監視アプリ（frontend/next-js）の境界の型。
// このファイルはリードが所有する（変更はリードに依頼する）。実装は control-plane 側で行い、
// next-js はここで export した型と createControlPlane だけを使う。
//
// 出典: DA-01 の図 3（E-15 AgentRun）、DD-01 の 3 節（相関 ID）・4.2 節（失敗分類）、
//       TA-07 の 3.5・3.6 節（定期実行・実行記録）、DD-06 の 1.2 節（skipped）

/** ULID（26 文字、Crockford Base32）。E-15 の run_id であり、E-12/E-13 に埋め込む相関 ID。 */
export type Ulid = string;

/** 起動の種類（DA-01 図 3 の trigger）。 */
export type RunTrigger = "schedule" | "manual" | "proposal";

/**
 * 実行の成否（DA-01 図 3 の outcome に DD-06 1.2 の skipped を足したもの）。
 * - partial: 一部の取得が truncated などで欠けたが成果物は出た
 * - skipped: 起動しなかった（前回が実行中・after の未達・起票前チェックで停止など）。理由は skipReason
 */
export type RunOutcome = "success" | "failure" | "partial" | "skipped";

/** 失敗分類 9 値（DD-01 4.2）。判定順は 4.4 に従う。 */
export type FailureClass =
  | "ok"
  | "empty_but_ok"
  | "timeout"
  | "unreachable"
  | "auth_failed"
  | "permission_denied"
  | "rate_limited"
  | "truncated"
  | "invalid_response";

/** 実行中は outcome が未確定。 */
export type RunStatus = "running" | "finished";

/**
 * E-15 AgentRun の 1 件（監視アプリの実行記録。正本はローカルの SQLite）。
 * ツールの結果は持たない。summary と targetIds だけを残す（ADR-18 の追加の決定 4）。
 */
export interface RunRecord {
  runId: Ulid;
  /** 定期実行の定義の id（ops/schedules/<id>.yaml）。手動の指示なら null。 */
  jobId: string | null;
  /** kind=agent のときのエージェント名（agent/ を付けない）。builtin なら null。 */
  agentName: string | null;
  /** kind=builtin のときの処理名。 */
  builtin: BuiltinJob | null;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string; // ISO 8601（タイムゾーン付き）
  finishedAt: string | null;
  outcome: RunOutcome | null;
  /** 個人情報を含まない要約。PII 検査を通した後の値。 */
  summary: string | null;
  /** PII 検査で伏せ字にしたかどうか。 */
  summaryRedacted: boolean;
  /** 触れた対象の ID（E-09 の id、E-10 の display_id、E-04 の documentId など）。 */
  targetIds: string[];
  /** outcome=skipped のときの理由（個人情報を含まない）。 */
  skipReason: string | null;
  /** outcome=failure/partial のときの分類。 */
  failureClass: FailureClass | null;
  /** Agent SDK の結果メッセージの subtype。builtin なら null。 */
  sdkSubtype: string | null;
  costUsd: number | null;
  /** S3 への写しが済んだ時刻。未送なら null。 */
  copiedAt: string | null;
}

/** エージェントを使わない、決まった処理（ops/schedules の builtin）。 */
export type BuiltinJob =
  | "heartbeat"
  | "i13-file"
  | "miswrite-check"
  | "silence-check"
  | "lighthouse"
  | "a11y"
  | "published-article-check"
  | "runlog-flush"
  | "n8n-export";

/** 定期実行の定義（承認済み main のチェックアウトから読んだもの）。 */
export interface JobDefinition {
  id: string;
  description: string;
  enabled: boolean;
  cron: string;
  kind: "agent" | "builtin";
  agent: string | null;
  builtin: BuiltinJob | null;
  after: string[];
  timeoutSec: number;
  maxTurns: number | null;
}

export interface JobStatus {
  definition: JobDefinition;
  nextRunAt: string | null;
  lastRun: RunRecord | null;
}

/** 誤った書き込みの候補（エージェント専用ユーザーの送信のうち、どの E-13 にも対応しないもの）。 */
export interface MiswriteCandidate {
  /** Chatwoot の会話の display_id。 */
  conversationDisplayId: number;
  messageId: number;
  sentAt: string;
  /** 送信時刻の前後で見つかった E-15 の run_id（無ければ null）。 */
  nearestRunId: Ulid | null;
  /** 理由（個人情報を含まない）。例: "no matching proposal" */
  reason: string;
}

export interface ListRunsQuery {
  limit?: number; // 既定 50、上限 200
  before?: Ulid; // この run_id より古いもの
  jobId?: string;
  outcome?: RunOutcome;
}

/** 手動の指示（監視アプリの画面から）。 */
export interface ManualRunRequest {
  /** 起動するエージェント名、または定期実行の定義の id。 */
  target: { kind: "agent"; agent: string; prompt: string } | { kind: "job"; jobId: string };
}

export interface ManualRunAccepted {
  runId: Ulid;
  /** 前回が実行中などで起動しなかった場合は skipped の記録が作られ、accepted=false になる。 */
  accepted: boolean;
}

export interface ControlPlane {
  /** スケジューラとハートビートを開始する（CONTROL_SCHEDULER_ENABLED=false ならハートビートと写しの再送だけ）。冪等。 */
  start(): Promise<void>;
  /** 実行中のエージェントを打ち切り、未送の写しを残して止める。冪等。 */
  stop(): Promise<void>;
  /** 手動で 1 回起動する。完了を待たずに返す。 */
  runNow(request: ManualRunRequest): Promise<ManualRunAccepted>;
  listRuns(query?: ListRunsQuery): Promise<RunRecord[]>;
  getRun(runId: Ulid): Promise<RunRecord | null>;
  listJobs(): Promise<JobStatus[]>;
  listMiswriteCandidates(): Promise<MiswriteCandidate[]>;
}

/**
 * 設定は control-plane が環境変数から zod で検証して作る（loadControlPlaneConfig）。
 * next-js は環境変数を直接読まず、この関数に任せる。
 */
export type CreateControlPlane = (options?: { env?: NodeJS.ProcessEnv }) => ControlPlane;
