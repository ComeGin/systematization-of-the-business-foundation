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
  | "n8n-export"
  | "cycle-open"
  | "cycle-collect"
  | "cycle-close"
  | "article-cover"
  | "campaign-asset-upload";

/** 改善ループの周の ID（C-<起点の日付>。例 C-2026-11-16。周は 14 日） */
export type CycleId = string;

/** E-13 の change.kind（docs/proposals/README.md）。実体の一覧は definitions/proposal.ts の PROPOSAL_KINDS */
export type ProposalKind =
  | "content_rewrite"
  | "cta_swap"
  | "internal_link"
  | "technical_seo"
  | "experiment_start"
  | "config_change"
  | "accessibility"
  | "email_campaign";

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
  /** 周の何日目（0〜13）に起動するか。null なら周を見ない。定期実行のときだけ見る（手動は見ない） */
  cycleDays: number[] | null;
  /** kind=agent のとき、起票してよい E-13 の change.kind。null なら制限しない */
  proposalKinds: ProposalKind[] | null;
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
  /**
   * 実行の順番と、止まったときの案内（承認済み main の setup/status/steps.mjs と setup/manual-steps.md から、見るたびに読む）。
   * 確認の結果ではないので保存しない。無効のとき・カタログを読めないときは null（古いカタログで RUN_ORDER が無ければ runOrder は空）
   */
  guide?: SetupGuide | null;
}

/** 実行の順番の 1 行（setup/README.md の「本番の段階」のコマンド） */
export interface SetupRunOrderEntry {
  id: string;
  /** 実行するコマンド。人が行う手順（配信）は null */
  command: string | null;
  /** 何をするか */
  note: string;
  /** そのコマンドで進める段階の id */
  steps: string[];
  /** steps の判定のうち最も重いもの（steps が空・まだ確かめていなければ null） */
  level: SetupStatusLevel | null;
}

/** 止まったときの案内（setup/manual-steps.md の 0 節の早見表の 1 行。どれも Markdown の 1 行で、リンクは文字にしてある） */
export interface SetupStopGuide {
  /** 1 列目（同じ行にまとめた id） */
  ids: string;
  /** いつ止まるか */
  when: string;
  /** 何をするか */
  what: string;
  /** 正本の節 */
  section: string;
}

export interface SetupGuide {
  runOrder: SetupRunOrderEntry[];
  /** 段階の id → その段階を進める（止まったあとにやり直す）コマンド。空の配列は人だけが行う段階。古いカタログで commands の無い段階は入らない */
  stepCommands: Record<string, string[]>;
  /** 止まる id（例 cloud:secrets）→ 早見表の行 */
  stopGuides: Record<string, SetupStopGuide>;
  /** 早見表を読めなかった理由（読めたら null） */
  stopTableError: string | null;
}

/** 手順書（Markdown）の 1 節。 */
export interface SetupDocSection {
  file: string;
  heading: string;
  markdown: string;
}

// ---- 改善ループ（14 日の周）の項目と承認 ----

/** 周の項目の種類。manual は config_change（人が行う作業。spec 5.11 の 4） */
export type CycleItemKind = "article" | "campaign" | "code" | "deploy" | "proposal" | "manual";

/** 項目の状態（spec 5.3） */
export type CycleItemState =
  | "preparing"
  | "awaiting_review"
  | "approved"
  | "executed"
  | "confirmed"
  | "rejected"
  | "failed_check";

/** 周の中の段階（画面の ①〜⑦） */
export type CycleStage = "collect" | "propose" | "draft" | "review" | "publish" | "evaluate" | "deploy";

/** 項目の種類ごとの確認用の内容。pending は準備中（まだ中身が無い）の項目に使う */
export type CycleItemPreview =
  | { kind: "pending" }
  | {
      kind: "article";
      documentId: string;
      slug: string;
      titleText: string;
      description: string;
      coverUrl: string | null;
      bodyMarkdown: string;
      /** アップロード済みで cover に結べていない画像のファイル ID（article-cover の cover-pending。手順に「表紙に結ぶ」を出す）。無ければ null か省略 */
      coverPendingFileId?: number | null;
      /** 中身を作ったときの下書きの updatedAt（公開の確認と反映の基準。Ruling 35）。この欄を足す前に作った項目では欠ける */
      draftUpdatedAt?: string;
    }
  | {
      kind: "campaign";
      articleDocumentId: string;
      linkUrl: string;
      emailId: number;
      emailSubject: string;
      emailBody: string;
      campaignId: number;
      segmentName: string;
      segmentCount: number;
      /** url は公開サイトでの配布ファイルの URL。記事にまだ結ばれていなければ null（手順に「記事に結ぶ」を出す） */
      assets: { name: string; url: string | null }[];
      /** キャンペーンの記事の、cover に結べていない画像のファイル ID（article と同じ） */
      coverPendingFileId?: number | null;
      /** キャンペーンの記事のアイキャッチ画像の URL（無ければ null。承認の条件。この欄を足す前に作った項目では欠ける） */
      coverUrl?: string | null;
    }
  | { kind: "code"; proposalId: string; files: string[]; diffStat: string }
  | {
      kind: "deploy";
      commitSha: string;
      distPath: string;
      lighthouse: { performance: number; accessibility: number; bestPractices: number; seo: number };
      changes: string[];
      blocked: string | null;
    }
  | {
      kind: "proposal";
      prNumber: number | null;
      prState: "open" | "approved" | "merged" | "closed" | null;
      /** PR の URL（GitHub の設定があり、PR の番号があるときだけ。無ければ null。この欄を足す前に作った項目では欠ける） */
      prUrl: string | null;
    }
  | { kind: "manual"; description: string };

export interface CycleItem {
  itemId: Ulid;
  cycleId: CycleId;
  kind: CycleItemKind;
  stage: CycleStage;
  /** 項目の同一性を決める参照。例 "PRP-2026-0012"・"strapi:article:<documentId>"・"deploy:<sha>" */
  sourceRef: string;
  proposalId: string | null;
  title: string;
  summary: string;
  evidence: { auditId: string; summary: string }[];
  preview: CycleItemPreview;
  state: CycleItemState;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  reflectedAt: string | null;
}

/** 項目への人の操作の記録 */
export interface CycleApproval {
  itemId: Ulid;
  action: "approve" | "reject" | "execute";
  actor: string;
  checked: string[];
  reason: string | null;
  at: string;
}

/** 周の締めの結果 */
export interface CycleCloseResult {
  reflectedFromProposals: number;
  reflectedFromKeywords: number;
  stuck: Record<"no_proposal" | "pr_not_approved" | "awaiting_review" | "not_executed" | "not_deployed", number>;
}

export interface CycleRow {
  cycleId: CycleId;
  startsAt: string;
  endsAt: string;
  manual: boolean;
  closedAt: string | null;
  close: CycleCloseResult | null;
}

/** 画面の「改善ループ」の 1 周分。cycle が null のときは reason に理由（設定が無い・まだ開かれていない）が入り、ほかは空 */
export interface CycleView {
  cycle: CycleRow | null;
  /**
   * cycle が null の理由。cycle があるときは、確認項目の定義を読めない（承認できない）などの警告があれば入る。無ければ null
   */
  reason: string | null;
  /** 7 段階すべて（collect → deploy の順）。count はその段階の項目の数。jobIds は定期実行の定義にある、その段階のジョブの id */
  stages: { stage: CycleStage; status: "done" | "awaiting" | "not_started" | "stuck"; count: number; jobIds: string[] }[];
  items: (CycleItem & {
    /** その種類の確認項目（ops/approval-checklists.yaml。OK は全部入れたときだけ押せる） */
    checklist: { id: string; label: string }[];
    /** OK の後に表示する手順（コピーできるコマンド付き） */
    steps: { text: string; command: string | null }[];
    approvals: CycleApproval[];
  })[];
  summary: {
    /** この周の項目に結びつく E-13 の数（改修案から作った項目。manual・proposal の項目は除く） */
    proposals: number;
    /** 反映の日がこの周の期間に入る E-13 の数（周をまたいで起票したものを含む。cycle-close と同じ数え方） */
    reflected: number;
    /** 準備中・OK 待ちの E-13 の数 */
    awaiting: number;
    rejected: number;
    /** 確かめられなかった（failed_check）か、確認の途中で理由が付いている E-13 の数 */
    stuck: number;
    /** 反映の日がこの周の期間に入る、E-13 に結びつかない記事（キーワード由来）の数 */
    keywordReflected: number;
  };
  /** 前の周に反映した E-13 の、30 日後の判定（承認済み main の E-13 の verification） */
  previousVerification: { proposalId: string; state: string; result: string | null }[];
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
  /** 改善ループの 1 周分。cycleId を省くと今日の周（C-YYYY-MM-DD 以外は ControlPlaneInputError）。 */
  getCycle(cycleId?: CycleId): Promise<CycleView>;
  /** 周の一覧（新しい周から）。 */
  listCycles(): Promise<CycleRow[]>;
  /**
   * 項目の OK。awaiting_review の項目だけ。checked は種類の確認項目の id の集合と過不足なく一致させる
   * （違えば ControlPlaneInputError）。proposal の項目・配信できない deploy の項目は受け付けない。actor は承認した人（メール）。
   * expectedUpdatedAt は画面で見た項目の updatedAt。確認の後に項目の中身が差し替えられていれば ControlPlaneInputError
   */
  approveCycleItem(itemId: Ulid, checked: string[], actor: string, expectedUpdatedAt: string): Promise<CycleView>;
  /** 差し戻し。理由は 1〜500 文字（PII 検査を通して保存）。awaiting_review・approved・failed_check の項目だけ */
  rejectCycleItem(itemId: Ulid, reason: string, actor: string): Promise<CycleView>;
  /** 「実行した」。approved・failed_check の項目を executed にし、確かめを非同期で始める（完了は待たない） */
  markCycleItemExecuted(itemId: Ulid, actor: string): Promise<{ accepted: boolean }>;
  /** 今日の周を手動で開く（既に開いていれば何もしない）。 */
  startCycle(actor: string): Promise<CycleView>;
}

/**
 * 設定は control-plane が環境変数から zod で検証して作る（loadControlPlaneConfig）。
 * next-js は環境変数を直接読まず、この関数に任せる。
 */
export type CreateControlPlane = (options?: { env?: NodeJS.ProcessEnv }) => ControlPlane;
