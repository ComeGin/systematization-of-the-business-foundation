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

/** 改善ループの中の段階（ops/schedules の stage。画面の表示名は next-js が持つ）。 */
export type JobStage = "measure" | "observe" | "propose" | "file" | "create" | "check" | "maintain" | "monitor";

/** ジョブの入出力（ops/schedules の io。人が書き起こした文。1 行 1 つ）。 */
export interface JobIo {
  reads: string[];
  writes: string[];
  /** 書かないもの（誤解されやすいものだけ）。yaml では does_not_write */
  doesNotWrite: string[];
}

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
  /** kind=agent のときの Agent への指示（画面に出す）。builtin では null */
  prompt: string | null;
  /** 処理の概要（2〜4 文）。書かれていなければ null */
  overview: string | null;
  stage: JobStage | null;
  /** 入出力。書かれていなければ null */
  io: JobIo | null;
}

/** ツールの参照／書き込みの目安（表示だけに使う。権限の判定には使わない）。 */
export type ToolAccess = "read" | "write" | "unknown";

/** Agent のツールを接続先ごとにまとめたもの。 */
export interface AgentToolGroup {
  /** null は組み込みのツール（Read・Write など） */
  server: string | null;
  /** 登録表（ops/mcp-registry.yaml）の access_level。組み込みと登録表に無い接続先は null */
  accessLevel: string | null;
  /** name は完全名（mcp__…）か組み込みの名前。定義に書かれた順 */
  tools: { name: string; access: ToolAccess }[];
}

/** Agent の定義（承認済み main の .claude/agents/<name>.md）と、それを使うジョブ。 */
export interface AgentInfo {
  name: string;
  description: string;
  model: string | null;
  disallowedTools: string[];
  /** 組み込みを先頭に、MCP は接続先の名前の順 */
  toolGroups: AgentToolGroup[];
  /** frontmatter を除いた本文（手順） */
  body: string;
  /** この Agent を agent に持つジョブの id（id の順） */
  jobIds: string[];
}

export interface AgentListing {
  /** 名前の順 */
  agents: AgentInfo[];
  /** 読めない定義（ファイル名と理由。値は含めない） */
  errors: { file: string; reason: string }[];
}

/** 観測（E-12）1 件の要約（frontmatter だけ。本文は読まない）。 */
export interface ObservationSummary {
  auditId: string;
  source: string | null;
  createdBy: string | null;
  /** fetch.outcome をそのまま（9 値以外も捨てない）。読めなければ null */
  outcome: string | null;
  /** fetch.note（エージェントが書いた理由の文） */
  note: string | null;
  /** fetch.measured_at */
  measuredAt: string | null;
  /** ファイルが見つかったか（対象にした観測で、作業ツリーにも main にも無ければ false） */
  found: boolean;
}

/** 1 回の実行の観測。written は fetch.correlation_id が runId と一致するもの、referenced は targetIds だけにあるもの。 */
export interface RunObservations {
  runId: Ulid;
  written: ObservationSummary[];
  referenced: ObservationSummary[];
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

/**
 * 設定の状況（setup/status の手順の一覧を、本番の状態に当てた結果）の判定。
 * ok=済み／action=人が対応する／warn=警告／manual=自動では確かめられない（申告・判断を含む）／unknown=確かめられなかった
 */
export type SetupStatusLevel = "ok" | "action" | "warn" | "manual" | "unknown";

export interface SetupStatusItemView {
  id: string;
  title: string;
  who: string;
  kind: string;
  level: SetupStatusLevel;
  /** 根拠（秘密値・個人情報を含まない短い文） */
  evidence: string;
  /** 設定スクリプトが止まるときの id（setup/manual-steps.md の早見表で引ける） */
  stopId: string | null;
  docs: { file: string; heading: string }[];
  checkedAt: string | null;
}

export interface SetupStatusStepView {
  id: string;
  title: string;
  level: SetupStatusLevel;
  items: SetupStatusItemView[];
}

export interface SetupStatusView {
  /** false なら steps は空で、reason に「本番の監視アプリだけで動く」など */
  enabled: boolean;
  /** カタログを読めない・設定が無いなど（値なし） */
  reason: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  running: boolean;
  counts: Record<SetupStatusLevel, number>;
  /** 直近の知らせの送信の失敗（種類だけ） */
  notifyError: string | null;
  steps: SetupStatusStepView[];
}

/** 手順書（Markdown）の 1 節。 */
export interface SetupDocSection {
  file: string;
  heading: string;
  markdown: string;
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
  /** 実行ごとの観測。入力の順。ULID でない id・E-15 に無い run は含めない。先頭の 200 件まで。 */
  listRunObservations(runIds: Ulid[]): Promise<RunObservations[]>;
  /** Agent の定義の一覧（承認済み main）。 */
  listAgents(): Promise<AgentListing>;
  /** Agent 1 件。名前が不正・定義が無い・読めないときは null。 */
  getAgent(name: string): Promise<AgentInfo | null>;
  listMiswriteCandidates(): Promise<MiswriteCandidate[]>;
  /** 設定の状況（直近の確認結果）。無効のときは enabled=false で steps は空。 */
  getSetupStatus(): Promise<SetupStatusView>;
  /** 設定の状況の確認を今すぐ始める。完了を待たずに返す。確認中なら accepted=false。 */
  refreshSetupStatus(): Promise<{ accepted: boolean }>;
  /** カタログの docs に現れる手順書の 1 節。許可されないファイル・見つからない見出しは null。 */
  readSetupDoc(file: string, heading: string): Promise<SetupDocSection | null>;
}

/**
 * 設定は control-plane が環境変数から zod で検証して作る（loadControlPlaneConfig）。
 * next-js は環境変数を直接読まず、この関数に任せる。
 */
export type CreateControlPlane = (options?: { env?: NodeJS.ProcessEnv }) => ControlPlane;
