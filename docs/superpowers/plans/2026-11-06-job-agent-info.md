# ジョブと Agent の「概要・入出力・結果の理由」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監視アプリのジョブの画面に処理の概要・入出力・結果の理由（観測の中身まで）を出し、Agent の一覧と詳細の画面を新しく作る。

**Architecture:** control-plane が、承認済み main の定義（ジョブの yaml・Agent の `.md`・MCP の登録表）と、作業ツリー／main の観測（E-12 の frontmatter）を読み、`contract.ts` の新しい型で next-js に渡す。next-js は Server Component のページでそれを受け、Cloudscape の部品で出す。ジョブの yaml 21 本には `overview`・`stage`・`io` を書き足す（すべて任意の欄）。

**Tech Stack:** TypeScript 7・zod v4・yaml（control-plane）、Next.js 16 App Router・React 19・Cloudscape・react-markdown（next-js）、vitest・Playwright。

**Spec:** `docs/superpowers/specs/2026-11-06-job-agent-info-design.md`（節番号はこの設計書のもの。実装の前に全文を読む）

## Global Constraints

- 定義（ジョブの yaml・`.claude/agents/*.md`・`ops/mcp-registry.yaml`）は `config.mainCheckout` からだけ読む（ADR-18）。作業ツリーからは読まない
- 観測（E-12）は `config.worktree` → `config.mainCheckout` の順に `docs/audits/<source>/<audit_id>.md` を読む。同じ `audit_id` は作業ツリーを優先する。読むのは frontmatter だけ
- 観測の ID は `^AUD-\d{4}-\d{4}-[a-z_]+-\d{4}$` に合うものだけ扱う。合わない `targetIds`（`E-05`・`LH-seo`・ULID・`../` を含むもの）は無視する
- `stage` の値と表示名は固定: `measure` 計測・`observe` 観測・`propose` 提案・`file` 起票・`create` 制作・`check` 点検・`maintain` 保守・`monitor` 監視（この順で並べる）
- yaml の新しい欄はすべて任意。無ければ画面は「（定義に書かれていない）」
- Agent が書いた文（`fetch.note`・`summary`）は文字として出す（Markdown・HTML として解釈しない）。500 文字を超えたら折りたたむ
- 「中身」は、その実行が**書いた**観測（`fetch.correlation_id` === `runId`）だけで決める。`targetIds` だけにある観測は「対象にした（読んだ）観測」として実行の詳細にだけ出す
- 画面から定義を変える操作は作らない
- 文書・コメント・テスト名は日本語。単体テストはメモリの「単体テストの書き方」の形（`describe("正常系")`/`describe("異常系")`、名前の接頭辞 `空入力: ` `入力: ` `サーバ: `）。E2E は既存の `e2e/` の形（`support/fixtures.mts` の `test`、サンドボックスは `support/sandbox.mjs`）
- **コミットしない**（`.claude/rules/git.md`。各タスクの最後は差分の確認まで。コミットはユーザーが行う）
- next-js は control-plane の `dist/` を読む。**next-js の型検査・テスト・E2E の前に `backend/control-plane` で `pnpm build`（tsc だけ）が要る**。これはユーザーに実行の許可を取ってから行う（`.claude/rules/build-deploy.md`。`next build` と `sam` はしない）
- `.env` は読まない・`grep -r` を `.env` のあるディレクトリに向けない（`rg` を使う）

## Review Focus

1. 観測の frontmatter が壊れている・`fetch` が無い → その観測は `found: true, outcome: null` として返し、「中身」では失敗として数え、表には「形が読めない」と出す（Task 2 のテスト）
2. 同じ `audit_id` が作業ツリーと main の両方にある → 作業ツリーの値を使い、二重に数えない（Task 2 のテスト）
3. `targetIds` に観測でない値・パスを抜ける値（`AUD-../x`）がある → 無視し、ファイルを開かない（Task 2 のテスト）
4. URL の Agent の名前が `AGENT_NAME_PATTERN` に合わない・定義が無い → 404（Task 6 のテスト）
5. `fetch.note` に `<script>` や `**太字**` が入っている → そのままの文字で出る（Task 5 のテスト）

---

### Task 1: ジョブの定義に `overview`・`stage`・`io` と公開の `prompt` を足す（control-plane）

**Files:**
- Modify: `backend/control-plane/src/contract.ts`（`JobDefinition` の近く）
- Modify: `backend/control-plane/src/definitions/schedules.ts`
- Modify: `backend/control-plane/src/index.ts:184-191`（`listJobs` が `prompt` を捨てるのをやめる）
- Test: `backend/control-plane/tests/definitions/schedules.test.ts`、`backend/control-plane/tests/index.test.ts`

**Interfaces:**
- Produces（`contract.ts`）:
  ```ts
  export type JobStage = "measure" | "observe" | "propose" | "file" | "create" | "check" | "maintain" | "monitor";
  export interface JobIo { reads: string[]; writes: string[]; doesNotWrite: string[] }
  // JobDefinition に追加
  overview: string | null;   // 前後の空白を落とし、空なら null
  stage: JobStage | null;
  io: JobIo | null;          // io が無ければ null。あれば 3 つとも配列（無いものは []）
  prompt: string | null;     // kind=agent のときだけ。今の ScheduleDefinition から公開の型へ移す
  ```
  `ScheduleDefinition` は `JobDefinition` と同じになるので、型の別名として残す（`export type ScheduleDefinition = JobDefinition`）
- yaml のキー: `overview`（文字列）、`stage`（上の 8 値）、`io.reads` `io.writes` `io.does_not_write`（文字列の配列）。`stage` が 8 値以外なら、そのファイルは今の不正な定義と同じく `errors` に入る

- [ ] **Step 1: 失敗するテストを書く**（`schedules.test.ts` の `loadSchedules` の中）
  - 正常系 `"overview・stage・io を読み、does_not_write は doesNotWrite にする"`: yaml に 3 つを書き、`jobs[0]` が `{ overview: "概要。", stage: "observe", io: { reads: ["A"], writes: ["B"], doesNotWrite: ["C"] } }` を含む
  - 正常系 `"空入力: overview・stage・io が無ければ null"`: 今の形の yaml で `overview: null, stage: null, io: null`
  - 正常系 `"io に reads だけがあれば writes と doesNotWrite は []"`
  - 正常系 `"kind=agent の prompt を公開の定義に含め、kind=builtin では null"`
  - 異常系 `"入力: stage が 8 値以外なら errors に入り、jobs に入らない"`（例 `stage: watch`）
  - `index.test.ts`: 既存の `listJobs` のテストに `definition.prompt` が入ることを足す
- [ ] **Step 2: 失敗を確かめる** — Run: `cd backend/control-plane && pnpm exec vitest run tests/definitions/schedules.test.ts tests/index.test.ts` / Expected: 上のテストが FAIL
- [ ] **Step 3: 実装する** — `ScheduleFileSchema` に `overview: z.string().nullable().default(null)`、`stage: z.enum([...]).nullable().default(null)`、`io: z.object({ reads, writes, does_not_write }).nullable().default(null)`（各配列は `.default([])`）を足し、`loadSchedules` の組み立てで写す。`listJobs` は `prompt` を残す
- [ ] **Step 4: 通ることを確かめる** — 同じコマンドで PASS。`pnpm typecheck` も通る
- [ ] **Step 5: 差分を確かめる** — `git diff --stat backend/control-plane`（コミットしない）

### Task 2: 観測（E-12）の索引と、実行ごとの「書いた／対象にした観測」（control-plane）

**Files:**
- Create: `backend/control-plane/src/definitions/audits.ts`
- Modify: `backend/control-plane/src/contract.ts`、`backend/control-plane/src/index.ts`
- Test: `backend/control-plane/tests/definitions/audits.test.ts`、`backend/control-plane/tests/index.test.ts`

**Interfaces:**
- Consumes: `RunRecord`（今の型）、`AUDITS_DIR`（`constants/paths.ts`）
- Produces（`contract.ts`）:
  ```ts
  export interface ObservationSummary {
    auditId: string;
    source: string | null;
    createdBy: string | null;
    outcome: string | null;      // fetch.outcome をそのまま（9 値以外も捨てない）。読めなければ null
    note: string | null;         // fetch.note
    measuredAt: string | null;   // fetch.measured_at
    found: boolean;              // ファイルが見つかったか（対象にした観測で、どこにも無ければ false）
  }
  export interface RunObservations { runId: Ulid; written: ObservationSummary[]; referenced: ObservationSummary[] }
  // ControlPlane に追加
  listRunObservations(runIds: Ulid[]): Promise<RunObservations[]>; // 入力の順。ULID でない id は結果に含めない。最大 200 件
  ```
- Produces（`audits.ts`）:
  ```ts
  export const AUDIT_ID_PATTERN: RegExp; // /^AUD-\d{4}-\d{4}-[a-z_]+-\d{4}$/
  export interface AuditIndex { byId: Map<string, ObservationSummary>; byCorrelation: Map<string, ObservationSummary[]> }
  export async function loadAuditIndex(roots: { worktree: string; mainCheckout: string }): Promise<AuditIndex>;
  export function observationsForRun(run: Pick<RunRecord, "runId" | "targetIds">, index: AuditIndex): RunObservations;
  ```
  `loadAuditIndex` は両方の `docs/audits/*/` の `*.md`（`README.md`・`_template.md` と `AUDIT_ID_PATTERN` に合わないファイル名は除く）の frontmatter を読む。`written` は `byCorrelation.get(runId)`（`auditId` の順）。`referenced` は `targetIds` のうち `AUDIT_ID_PATTERN` に合い、`written` に無いもの（無ければ `found: false` で他は null）。キャッシュは持たない（呼ぶたびに読む）

- [ ] **Step 1: 失敗するテストを書く**（`audits.test.ts`。一時ディレクトリに作業ツリーと main を作る。ファイル操作が対象なので実ファイルでよい）
  - 正常系 `"correlation_id が runId と一致する観測を written に、targetIds だけにある観測を referenced に分ける"`
  - 正常系 `"targetIds が [] でも、correlation_id が一致する観測は written に入る"`（2026-11-06 の `daily-observe-ops` の形）
  - 正常系 `"同じ audit_id が作業ツリーと main にあれば作業ツリーの値を使い、1 件だけ返す"`
  - 正常系 `"main にだけある観測も読む"`
  - 正常系 `"空入力: docs/audits が無ければ written も referenced も []"`
  - 異常系 `"入力: targetIds の E-05・LH-seo・ULID・AUD-../x は無視し、ファイルを開かない"`
  - 異常系 `"入力: frontmatter が壊れた観測は found: true・outcome: null で返す"`
  - 異常系 `"入力: targetIds の観測がどこにも無ければ found: false"`
  - 異常系 `"入力: README.md と _template.md は索引に入れない"`
  - `index.test.ts`: `listRunObservations` が入力の順に返し、ULID でない id を落とす
- [ ] **Step 2: 失敗を確かめる** — Run: `cd backend/control-plane && pnpm exec vitest run tests/definitions/audits.test.ts tests/index.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — frontmatter の取り出しは `agent-def.ts` と同じ正規表現（`^---\r?\n([\s\S]*?)\r?\n---`）＋ `yaml` の `parse`。`ControlPlaneImpl.listRunObservations` は `this.ctx.runs.get` で各 run を引き、索引を 1 回だけ作って `observationsForRun` に渡す
- [ ] **Step 4: 通ることを確かめる** — 同じコマンドで PASS、`pnpm typecheck`
- [ ] **Step 5: 差分を確かめる**

### Task 3: Agent の一覧・詳細とツールの分類（control-plane）

**Files:**
- Create: `backend/control-plane/src/definitions/agent-catalog.ts`
- Modify: `backend/control-plane/src/contract.ts`、`backend/control-plane/src/index.ts`
- Test: `backend/control-plane/tests/definitions/agent-catalog.test.ts`、`backend/control-plane/tests/index.test.ts`

**Interfaces:**
- Consumes: `loadAgentDefinition`・`AGENT_NAME_PATTERN`（`agent-def.ts`）、`loadMcpRegistry`（`registry.ts`）、`loadSchedules`（Task 1）
- Produces（`contract.ts`）:
  ```ts
  export type ToolAccess = "read" | "write" | "unknown";
  export interface AgentToolGroup {
    server: string | null;        // null = 組み込みのツール（Read・Write など）
    accessLevel: string | null;   // 登録表の access_level（組み込みと登録表に無い接続先は null）
    tools: { name: string; access: ToolAccess }[]; // name は完全名（mcp__…）か組み込みの名前
  }
  export interface AgentInfo {
    name: string; description: string; model: string | null;
    disallowedTools: string[]; toolGroups: AgentToolGroup[];
    body: string;      // frontmatter を除いた本文
    jobIds: string[];  // この Agent を agent に持つジョブの id（id の順）
  }
  export interface AgentListing { agents: AgentInfo[]; errors: { file: string; reason: string }[] }
  // ControlPlane に追加
  listAgents(): Promise<AgentListing>;           // 名前の順
  getAgent(name: string): Promise<AgentInfo | null>; // 名前が AGENT_NAME_PATTERN に合わない・定義が無い・読めないときは null
  ```
- Produces（`agent-catalog.ts`）:
  ```ts
  export function classifyTool(tool: string, registry: McpRegistry): { server: string | null; access: ToolAccess };
  export function buildAgentInfo(definition: AgentDefinition, jobs: JobDefinition[], registry: McpRegistry): AgentInfo;
  export async function listAgentDefinitions(mainCheckout: string): Promise<{ definitions: AgentDefinition[]; errors: { file: string; reason: string }[] }>;
  ```
- `classifyTool` の決まり（設計書 7 節）:
  1. `mcp__<server>__<name>` で、登録表の `<server>` の `access_level` が `read_only` → `read`
  2. それ以外の MCP は、`<name>` から `<server>` の `-prod`・`-ro`・`-dev` を除いた名前に `_` を付けた接頭辞（例 `chatwoot-prod` → `chatwoot_`）があれば取り、残りが `list` `get` `query` `search` `find` `inspect` `whoami` `estimate` `execute-sql` で始まれば `read`、`create` `update` `add` `delete` `remove` `set` `send` `save` `run` `merge` で始まれば `write`、ほかは `unknown`
  3. 組み込みの `Write` `Edit` `NotebookEdit` → `write`、`Read` `Glob` `Grep` `WebSearch` `WebFetch` → `read`、ほかは `unknown`
  - `toolGroups` は組み込みを先頭に、MCP は接続先の名前の順

- [ ] **Step 1: 失敗するテストを書く**（`agent-catalog.test.ts`。登録表は `McpRegistry` を手で組む）
  - 正常系 `"chatwoot_add_private_note は接頭辞を取って write、chatwoot_list_conversations は read"`
  - 正常系 `"read_only の接続先のツールは名前に関わらず read（mautic-prod-ro の mautic_run_report）"`
  - 正常系 `"openseo の get_search_console_performance は read、research_keywords は unknown"`
  - 正常系 `"組み込みの Write は write、Read は read"`
  - 正常系 `"buildAgentInfo は組み込みを先頭に接続先ごとにまとめ、jobIds にその Agent のジョブだけを入れる"`
  - 正常系 `"空入力: tools が空なら toolGroups は []、使うジョブが無ければ jobIds は []"`
  - 異常系 `"入力: 登録表に無い接続先は accessLevel: null で、名前の規則だけで分ける"`
  - 異常系 `"入力: listAgentDefinitions は name がファイル名と違う定義を errors に入れ、ほかは返す"`
  - `index.test.ts`: `getAgent("../x")` と `getAgent("no-such")` が null、`listAgents` が名前の順
- [ ] **Step 2: 失敗を確かめる** — Run: `cd backend/control-plane && pnpm exec vitest run tests/definitions/agent-catalog.test.ts tests/index.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — `listAgentDefinitions` は `.claude/agents/*.md` のファイル名から名前を取り、`AGENT_NAME_PATTERN` に合うものだけ `loadAgentDefinition` で読む（`AgentDefinitionError` は `errors` に。理由の文だけで値は出さない）。登録表が読めないときは空の登録表として扱い、`logLine("WARN", …)` を出す
- [ ] **Step 4: 通ることを確かめる** — 同じコマンドで PASS、`pnpm typecheck`
- [ ] **Step 5: 差分を確かめる**

### Task 4: 設定の状況の確認間隔（1 時間）に合わせてテストを直し、control-plane を全部通す

**Files:**
- Modify: `backend/control-plane/tests/status/service.test.ts`
- Modify: `backend/control-plane/README.md`（新しい 3 つの方法と、観測を読む場所の表）

**Interfaces:**
- Consumes: `CHECK_INTERVAL_MS`・`PRODUCT_API_INTERVAL_MS`・`PRODUCT_API_DUE_SLACK_MS`（`src/status/service.ts`。2026-11-04 に変更済み）

- [ ] **Step 1: 落ちるテストを確かめる** — Run: `cd backend/control-plane && pnpm exec vitest run tests/status/service.test.ts` / Expected: 10 分を前提にした箇所が FAIL
- [ ] **Step 2: テストを直す** — 時間を直接書いている箇所（`10 * 60 * 1000` など）を `CHECK_INTERVAL_MS` の import に置き換え、テスト名の「10 分ごと」を「1 時間ごと」に。製品の API の回の判定は「1 時間ちょうど・1 分足りない（59 分）・1 分を超えて足りない（58 分 59 秒）」の 3 つを足す（前 2 つは呼ぶ、最後は呼ばない）
- [ ] **Step 3: 全部を通す** — Run: `cd backend/control-plane && pnpm typecheck && pnpm test` / Expected: すべて PASS
- [ ] **Step 4: README を直し、差分を確かめる**

### Task 5: 中身の表示の部品と実行記録の画面（next-js）

**前提:** ここから next-js。ユーザーの許可を取ってから `cd backend/control-plane && pnpm build` を実行する（Global Constraints）。

**Files:**
- Create: `frontend/next-js/components/common/failure-class.ts`
- Create: `frontend/next-js/components/runs/observation-format.ts`
- Create: `frontend/next-js/components/runs/ContentStatus.tsx`
- Create: `frontend/next-js/components/runs/ObservationsTable.tsx`
- Create: `frontend/next-js/components/common/AgentText.tsx`（Agent が書いた文を文字のまま出し、500 文字超で折りたたむ）
- Modify: `frontend/next-js/components/runs/RunsTable.tsx`、`RunsListView.tsx`、`RunDetailView.tsx`
- Modify: `frontend/next-js/app/(console)/runs/page.tsx`、`app/(console)/runs/[runId]/page.tsx`
- Modify: `frontend/next-js/tests/helpers/control-plane.ts`（偽物に `listRunObservations`・`listAgents`・`getAgent` を足す）
- Test: `frontend/next-js/tests/components/runs/observation-format.test.ts`、`tests/components/common/failure-class.test.ts`、`tests/components/common/AgentText.test.tsx`、`tests/app/(console)/runs/page.test.ts`、`tests/app/(console)/runs/[runId]/page.test.ts`

**Interfaces:**
- Consumes: `RunObservations`・`ObservationSummary`・`FailureClass`（control-plane の型）
- Produces:
  ```ts
  // failure-class.ts
  export function describeOutcome(value: string | null): { label: string; meaning: string; ok: boolean };
  // 9 値の label と meaning を持つ。ok/empty_but_ok だけ ok: true。null → { label: "形が読めない", ok: false }、9 値以外 → label にそのままの値、meaning「定義に無い分類」、ok: false
  // invalid_response の meaning は「上流が 2xx 以外（5xx を含む）を返した、または解釈できない応答」

  // observation-format.ts
  export type ContentSummary =
    | { kind: "none" }
    | { kind: "ok"; total: number }
    | { kind: "failed"; failed: number; total: number };
  export function summarizeContent(observations: RunObservations | undefined): ContentSummary; // written だけで決める

  // ContentStatus.tsx
  export function ContentStatus(props: { observations: RunObservations | undefined }): JSX.Element; // 「-」「問題なし（N 件）」「取得に失敗 M / N 件」（StatusIndicator の error）
  // ObservationsTable.tsx
  export function ObservationsTable(props: { title: string; observations: ObservationSummary[]; empty: string }): JSX.Element; // 列: 観測 ID・取得の結果（label と meaning）・理由（AgentText）・見つかったか
  // RunsTable に observations?: Map<string, RunObservations> を足し、「中身」の列を「状態」の次に置く
  // RunDetailView に observations: RunObservations | null を足し、「この実行が書いた観測」と「この実行が対象にした（読んだ）観測」の 2 表を出す
  ```
  ページは `listRuns` の結果の `runId` で `listRunObservations` を 1 回呼び、`Map` にして渡す

- [ ] **Step 1: 失敗するテストを書く**
  - `observation-format.test.ts`: 正常系 `"空入力: written が無ければ none"`、`"ok と empty_but_ok だけなら ok"`、`"permission_denied が 1 件あれば failed 1 / 2"`、`"referenced の失敗は数えない"`。異常系 `"入力: outcome が null の観測は失敗として数える"`
  - `failure-class.test.ts`: 9 値すべてに label と meaning がある、`invalid_response` の meaning に「5xx」を含む、異常系 `"入力: 定義に無い分類はそのままの値を label にして ok: false"`
  - `AgentText.test.tsx`: 異常系 `"入力: <script> と **太字** を含む文はそのままの文字で出る"`、正常系 `"500 文字を超える文は折りたたまれ、開くと全文が出る"`
  - ページのテスト: `/runs` が `listRunObservations` を表示中の `runId` で 1 回呼ぶ、`/runs/[runId]` が書いた観測と対象にした観測を渡す
- [ ] **Step 2: 失敗を確かめる** — Run: `cd frontend/next-js && pnpm exec vitest run tests/components tests/app/\(console\)/runs` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンドで PASS、`pnpm typecheck && pnpm lint`
- [ ] **Step 5: 差分を確かめる**

### Task 6: Agent の画面（一覧・詳細）とメニュー（next-js）

**Files:**
- Create: `frontend/next-js/app/(console)/agents/page.tsx`、`app/(console)/agents/[name]/page.tsx`
- Create: `frontend/next-js/components/agents/AgentsListView.tsx`、`AgentDetailView.tsx`、`help.tsx`（既存の `components/jobs/help.tsx` と同じ形）
- Create: `frontend/next-js/components/common/Markdown.tsx`（`components/setup-status/DocSection.tsx` の `MARKDOWN_COMPONENTS` と描画をここへ移し、`DocSection` もこれを使う）
- Modify: `frontend/next-js/components/layout/routes.ts`（`AGENTS = { text: "Agent", href: "/agents" }`、`NAVIGATION_ITEMS` の `JOBS` の次、パンくず）、`components/setup-status/DocSection.tsx`
- Test: `frontend/next-js/tests/app/(console)/agents/page.test.ts`、`tests/app/(console)/agents/[name]/page.test.ts`、`tests/components/layout/routes.test.ts`（既存があれば足す）、`tests/components/setup-status/`（DocSection の既存のテストが通ること）

**Interfaces:**
- Consumes: `listAgents`・`getAgent`（Task 3）、`listJobs`（Task 1）、`listRuns`・`listRunObservations`（Task 2）、`ContentStatus`（Task 5）
- Produces: 詳細は `getAgent` が null なら `notFound()`。直近の実行は `listRuns({ limit: 50 })` から `agentName` が一致するものを新しい順に 5 件（`listRuns` に agent の絞り込みは無いので足さない）

画面の中身は設計書 7 節のとおり（一覧: 名前・役割の先頭の一文〈最初の「。」まで〉・使うジョブの数〈0 は「なし（手動だけ）」〉、読めない定義の Alert。詳細: 役割の全文・モデル・接続先とツール〈`write` は目立つ色、`accessLevel` を接続先の横に〉・`disallowedTools`・使うジョブ〈リンク・cron・有効〉・直近の実行と中身・手順の全文を `Markdown` で）。

- [ ] **Step 1: 失敗するテストを書く**
  - 一覧: 正常系 `"listAgents の Agent を名前の順に出し、使うジョブが 0 なら『なし（手動だけ）』"`、`"読めない定義があれば名前と理由を出す"`、`"空入力: Agent が 0 本なら空の表示"`
  - 詳細: 正常系 `"役割・接続先ごとのツール・使うジョブ・手順を渡す"`、異常系 `"入力: getAgent が null なら notFound"`、`"入力: 名前が AGENT_NAME_PATTERN に合わなければ getAgent を呼ばずに notFound"`
  - routes: `NAVIGATION_ITEMS` の `定期実行のジョブ` の次が `Agent`
- [ ] **Step 2: 失敗を確かめる** — Run: `cd frontend/next-js && pnpm exec vitest run tests/app/\(console\)/agents tests/components` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンドと `pnpm typecheck && pnpm lint`
- [ ] **Step 5: 差分を確かめる**

### Task 7: ジョブの一覧・詳細（① 概要 ② 入出力 ③ Agent ④ 直近の結果と理由）（next-js）

**Files:**
- Modify: `frontend/next-js/components/jobs/job-format.tsx`（`STAGES`・`stageLabel`）、`JobsListView.tsx`、`JobDetailView.tsx`
- Modify: `frontend/next-js/app/(console)/jobs/page.tsx`、`app/(console)/jobs/[jobId]/page.tsx`
- Test: `frontend/next-js/tests/components/jobs/job-format.test.ts`、`tests/app/(console)/jobs/page.test.ts`、`tests/app/(console)/jobs/[jobId]/page.test.ts`

**Interfaces:**
- Consumes: Task 1〜3 の型、`ContentStatus`・`ObservationsTable`・`AgentText`（Task 5）
- Produces:
  ```ts
  // job-format.tsx
  export const STAGES: readonly JobStage[]; // measure, observe, propose, file, create, check, maintain, monitor
  export function stageLabel(stage: JobStage | null): string; // null → "（定義に書かれていない）"
  export function dependentsOf(jobId: string, jobs: JobDefinition[]): string[]; // その id を after に持つジョブ（id の順）
  ```
  一覧のページは `listJobs` の `lastRun` の `runId` で `listRunObservations` を 1 回呼ぶ。詳細のページは、ジョブの実行記録の `runId` で 1 回呼び、Agent のジョブなら `getAgent(definition.agent)` も呼ぶ（null でもページは出し、③ に「Agent の定義が見つからない」）

画面の並びは設計書 5 節・8 節のとおり。① は `overview`（無ければ「（定義に書かれていない）」）と、`STAGES` を並べて今の段階を強調。② は「読むもの」「書くもの」「書かないもの」「待つもの（`after`）／待たれるもの（`dependentsOf`）」。定義の箱に `prompt` の折りたたみ（全文。`AgentText` ではなく等幅の文字）。③ は Agent の名前のリンク（`/agents/<name>`）・`description` の先頭の一文・接続先の名前。④ は `lastRun` の結果・所要時間・費用・`ObservationsTable`（書いた観測）・要約・見送りの理由・`describeOutcome(failureClass)`。

- [ ] **Step 1: 失敗するテストを書く**
  - `job-format.test.ts`: `"STAGES は 8 値をこの順で持つ"`、`"空入力: stageLabel(null) は（定義に書かれていない）"`、`"dependentsOf は after にその id を持つジョブを返す"`、`"空入力: 待たれるジョブが無ければ []"`
  - ジョブのページ: 正常系 `"一覧は lastRun の runId で listRunObservations を 1 回呼ぶ"`、`"詳細は Agent のジョブで getAgent を呼び、builtin では呼ばない"`、異常系 `"入力: getAgent が null でも詳細を出す"`
- [ ] **Step 2: 失敗を確かめる** — Run: `cd frontend/next-js && pnpm exec vitest run tests/components/jobs tests/app/\(console\)/jobs` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 全部を通す** — Run: `cd frontend/next-js && pnpm typecheck && pnpm lint && pnpm test` / Expected: すべて PASS
- [ ] **Step 5: 差分を確かめる**

### Task 8: E2E（サンドボックスの定義を足し、ジョブ・Agent・実行記録の中身を画面で通す）

**Files:**
- Modify: `frontend/next-js/e2e/support/sandbox.mjs`（エージェントの定義に MCP のツールを足し、`ops/mcp-registry.yaml` を置き、ジョブ 1 本に `overview`・`stage`・`io` を書く。観測を置く関数を足す）
- Modify: `frontend/next-js/e2e/jobs.spec.mts`、`e2e/runs.spec.mts`
- Create: `frontend/next-js/e2e/agents.spec.mts`

**Interfaces:**
- Produces（`sandbox.mjs`）:
  ```js
  export const AGENT_TOOLS = "Read, Write, mcp__e2e-prod__e2e_list_items, mcp__e2e-prod__e2e_add_note, mcp__e2e-ro__e2e_run_report";
  // ops/mcp-registry.yaml に e2e-prod（read_write）と e2e-ro（read_only）を http で置く（URL は 127.0.0.1 の使わないポート。接続はしない）
  export function writeObservation({ auditId, source, correlationId, outcome, note }): void; // WORKTREE の docs/audits/<source>/<auditId>.md に frontmatter だけ書く
  ```
  `JOBS.agent` の yaml に `overview`・`stage: observe`・`io`（reads・writes・does_not_write 各 1 行）を書く。ほかの 3 本は書かない（「（定義に書かれていない）」の確認に使う）

- [ ] **Step 1: E2E を書く**
  - `jobs.spec.mts` 正常系 `"Agent のジョブの詳細に概要・段階・入出力・Agent へのリンクが出る"`、`"overview の無いジョブは（定義に書かれていない）と出る"`
  - `agents.spec.mts` 正常系 `"メニューから Agent の一覧へ行き、詳細で接続先ごとのツールと書き込みの印、使うジョブ、手順が出る"`（`e2e_add_note` が書き込み、`e2e_run_report` が参照）、異常系 `"入力: 無い Agent の URL は 404"`
  - `runs.spec.mts` 正常系 `"Agent のジョブを手動で起動した後に、その runId を correlation_id に持つ permission_denied の観測を置くと、一覧の中身が『取得に失敗 1 / 1 件』、詳細に理由が出る"`、異常系 `"入力: note の <script> はそのままの文字で出る"`。後片付けは `cleanup.add` で観測のファイルを消す
- [ ] **Step 2: 実行する** — Run: `cd frontend/next-js && pnpm e2e` / Expected: 既存と新しい spec がすべて PASS（前提: 開発スタックの Chatwoot が動いている・`backend/control-plane` の `pnpm build` 済み）
- [ ] **Step 3: 差分を確かめる**

### Task 9: ジョブの yaml 21 本の書き起こしと文書

**Files:**
- Modify: `ops/schedules/*.yaml`（21 本すべて）
- Modify: `ops/README.md`（「定期実行の定義」の表に `overview`・`stage`・`io`）、`frontend/next-js/README.md`（Agent の画面・中身の列）

- [ ] **Step 1: 書き起こす** — 各ジョブについて、Agent のジョブは `.claude/agents/<agent>.md` と yaml の `prompt`、builtin は `backend/control-plane/src/builtin/<name>.ts` を読み、設計書 4 節の決まり（事実だけ・`overview` は 2〜4 文・`stage` は 8 値）で書く。実装と食い違いが見つかったら yaml を直さずに一覧にして報告する
- [ ] **Step 2: 読めることを確かめる** — Run: `cd backend/control-plane && node --input-type=module -e "import('./dist/definitions/schedules.js').then(async m => { const r = await m.loadSchedules('../..'); console.log(r.jobs.length, r.errors, r.jobs.filter(j => !j.overview || !j.stage || !j.io).map(j => j.id)); })"` / Expected: `21 [] []`（Task 1 の後に `pnpm build` 済みであること）
- [ ] **Step 3: 差分を確かめる** — `git diff --stat ops`
