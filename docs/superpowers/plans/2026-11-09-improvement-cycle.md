# 改善ループの 1 周（2 週間の周と承認の画面）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顧客のシグナル由来の改修案（E-13）を、2 週間の周の中で下書き・差分にし、監視アプリの「改善ループ」画面で人が確認項目を見て OK を出し、表示された手順とコマンドで人が公開・送信・配信して、反映をシステムが確かめるところまでを通す。

**Architecture:** 既存の `backend/control-plane`（定期実行・E-15 の SQLite・builtin・Agent SDK）に「周」と「項目」の層（`src/cycle/`・`src/store/cycles.ts`）を足し、builtin を 6 本（`cycle-open`・`cycle-collect`・`cycle-close`・`article-cover`・`campaign-asset-upload`・実装する `published-article-check`）と、定期実行の欄 2 つ（`cycle_days`・`proposal_kinds`）を加える。エージェントは 1 本足し（`campaign-planner`）、2 本に E-13 モードを足す。`frontend/next-js` に `/cycle` の画面と API を足し、境界の型は `contract.ts` に置く。

**Tech Stack:** TypeScript（Node 24・`node:sqlite`）、zod v4、croner、Claude Agent SDK、公式 `openai` npm、`fflate`（zip）、`ajv`（JSON スキーマの検証）、`playwright-core`（PDF）、Next.js 16＋Cloudscape、pnpm 11。

**Spec:** `docs/superpowers/specs/2026-11-09-improvement-cycle-design.md`（以下「spec」。各タスクの節番号は spec の節）

## Global Constraints

- ドキュメント・コメント・画面の文言・エラー文は日本語（モデルに返すフックの拒否理由だけは既存に合わせて英語の短文）。
- パッケージは pnpm 11。依存の追加は `pnpm add`（`pnpm-workspace.yaml` の `minimumReleaseAge` に従う。版は公開から 2 週間以上のもの）。
- **テストコードの作成とテストの実行は、ユーザーの明確な指示があるときだけ**（`.claude/rules/devops-testing.md`）。各タスクの「テスト」の段は、指示があるときに行う。指示が無いときは飛ばし、`pnpm typecheck` と `pnpm lint`（next-js）で確かめる。テストを書くときは既存の書き方（メモリの単体テストの規則: 正常系／異常系を分け、`空入力:`・`入力:`・`サーバ:` の接頭辞、外部はモック）に従う。
- **ビルド（`pnpm build`・`astro build`）とデプロイは実行しない**（`.claude/rules/build-deploy.md`）。
- **git の状態を変えるコマンドは使わない**（`.claude/rules/git.md`）。各タスクの最後は「差分の確認」（`git status`・`git diff --stat`）で、コミットは人が行う。
- 秘密値（`OPENAI_API_KEY`・Strapi のトークン・Mautic の認証情報）は control-plane の設定（`config.ts`）だけが持ち、エージェントの子プロセスの `env`・ログ・画面・E-15 の要約に出さない。設定の誤りは「変数名と理由だけ」（値は出さない）。
- 新しい定期実行の定義はすべて `enabled: false`。時刻は JST の 0〜8 時に起動し、`起動 + timeout_sec` が 8 時より前。月曜 03:00〜03:30 を空ける。Chatwoot を読むものは 03:45 より後。
- エージェントに公開・送信・配信・セグメント作成の手段を渡さない（spec 3 節・5.8・5.11 の 3）。
- 周は 14 日。起点は `CONTROL_CYCLE_ANCHOR`（`YYYY-MM-DD`、月曜）。周の ID は `C-<起点の日付>`（例 `C-2026-11-16`）。周の何日目は 0〜13。
- 項目の状態は `preparing`・`awaiting_review`・`approved`・`executed`・`confirmed`・`rejected`・`failed_check` の 7 値（spec 5.3）。項目の種類は `article`・`campaign`・`code`・`deploy`・`proposal`・`manual` の 6 値（`manual` は `config_change`。spec 5.11 の 4）。
- E-13 の `change.kind` に `email_campaign` を足す。`experiment_start` は値として残し、`proposal-writer` は起票しない。
- 画面に個人情報を出さない（メールの送信先は件数とセグメント名だけ）。画面に出す要約は `redactSummary`（`src/pii.ts`）を通す。

## Review Focus

- **周の起点の設定が無い・形が違う**: 周に関わるジョブは `skipped`（理由「CONTROL_CYCLE_ANCHOR が無い」）になり、他のジョブと画面の他の部分は動く → Task 1 のテスト `空入力: anchor が無いと cycle_days のジョブは skipped`。
- **同じ E-13 から項目を二重に作る**（`cycle-collect` が毎日動く・作用のジョブが再実行される）: 項目は `(kind, source_ref)` で一意で、2 回目は既存を更新するだけ → Task 2 のテスト `入力: 同じ source_ref の upsert は 1 件のまま`、Task 3 のテスト `入力: 項目のある E-13 は選ばない`。
- **人が「実行した」を押したが、実際は未実行・途中**（Strapi で未公開、配信の転送が途中）: `failed_check` になり理由（何が確かめられなかったか）を出し、もう一度押せる。`confirmed` にしない → Task 8 のテスト `サーバ: publishedAt が null なら failed_check`、`サーバ: _build.json の SHA が違えば failed_check`。
- **確認項目を全部入れずに OK を送る**（画面を通さない API の直接呼び出しを含む）: API が 400 を返し、状態を変えない → Task 9 のテスト `入力: checked が定義の項目と一致しなければ ControlPlaneInputError`。
- **配信の前に `LH-seo` が 1.0 未満**: `deploy` の項目は手順を出さず「配信できない」と理由を出す → Task 5 のテスト `入力: SEO 0.98 なら blocked で commands が空`。

---

## ファイルの構成

| ファイル | 役割 |
|---|---|
| `backend/control-plane/src/cycle/calendar.ts` | 周の ID・何日目の計算（純粋関数） |
| `backend/control-plane/src/cycle/proposals.ts` | `main` の承認済み E-13 の読み出しと、作用のジョブに渡す 1 件の選択 |
| `backend/control-plane/src/cycle/checklists.ts` | `ops/approval-checklists.yaml` の読み込み |
| `backend/control-plane/src/cycle/commands.ts` | 項目の種類ごとの「手順とコマンド」の組み立て（純粋関数） |
| `backend/control-plane/src/cycle/confirm.ts` | 「実行した」の後の確認（種類ごと） |
| `backend/control-plane/src/cycle/reflection.ts` | 反映の数え方（純粋関数） |
| `backend/control-plane/src/cycle/service.ts` | 画面向けの操作（周の取得・OK・差し戻し・実行した・周を始める） |
| `backend/control-plane/src/store/cycles.ts` | 周・項目・承認の記録の SQLite |
| `backend/control-plane/src/integrations/strapi.ts` | 本番の Strapi の Content API（読み取り）とアップロード |
| `backend/control-plane/src/integrations/mautic.ts` | Mautic の読み取り（OAuth2 client_credentials） |
| `backend/control-plane/src/integrations/openai-image.ts` | OpenAI SDK での画像生成 |
| `backend/control-plane/src/builtin/cycle.ts` | `cycle-open`・`cycle-collect`・`cycle-close` |
| `backend/control-plane/src/builtin/published-article-check.ts` | 公開とマージの検知 → ビルドと計測 → `deploy` の項目（`simple.ts` の雛形を置き換える） |
| `backend/control-plane/src/builtin/article-cover.ts` | アイキャッチ画像 |
| `backend/control-plane/src/builtin/campaign-asset-upload.ts` | Plugin の検証・zip・PDF・Strapi へのアップロード |
| `frontend/next-js/app/(console)/cycle/page.tsx`・`[cycleId]/page.tsx` | 画面 |
| `frontend/next-js/app/api/cycle/**/route.ts` | API |
| `frontend/next-js/components/cycle/*.tsx` | 画面の部品 |
| `ops/schedules/cycle-*.yaml`・`article-cover.yaml`・`campaign-asset-upload.yaml` | 定期実行の定義 |
| `ops/approval-checklists.yaml`・`ops/prompts/article-cover.md`・`ops/schemas/agent-plugins-1.0.0/plugin.schema.json` | 定義・雛形・スキーマの写し |
| `.claude/agents/campaign-planner.md` | 新しいエージェント |

---

### Task 1: 周の暦と、定期実行の欄 `cycle_days`・`proposal_kinds`

**Files:**
- Create: `backend/control-plane/src/cycle/calendar.ts`
- Modify: `backend/control-plane/src/config.ts`（`CONTROL_CYCLE_ANCHOR`）、`backend/control-plane/src/definitions/schedules.ts`、`backend/control-plane/src/contract.ts`（`JobDefinition`）、`backend/control-plane/src/engine.ts`（`prepare`）
- Test: `backend/control-plane/tests/cycle/calendar.test.ts`、`tests/definitions/schedules.test.ts`、`tests/engine.test.ts`

**Interfaces:**
- Produces:
  - `export type CycleId = string`（`contract.ts`）
  - `cycleOf(date: Date, anchor: string): { cycleId: CycleId; day: number; startsAt: string; endsAt: string }`（`calendar.ts`。`startsAt` は起点の 00:00 JST、`endsAt` は 14 日後の 00:00 JST の ISO 8601。起点より前の日付は直前の周〈負の周〉も同じ式で求める）
  - `ControlPlaneConfig.cycleAnchor: string | null`
  - `JobDefinition.cycleDays: number[] | null`、`JobDefinition.proposalKinds: ProposalKind[] | null`
  - `export type ProposalKind = "content_rewrite" | "cta_swap" | "internal_link" | "technical_seo" | "experiment_start" | "config_change" | "accessibility" | "email_campaign"`（`contract.ts`）

- [ ] **Step 1（テスト。指示があるとき）:** `calendar.test.ts`
  - `入力: 起点 2026-11-16 の 2026-11-16T00:00+09:00 は C-2026-11-16 の 0 日目`
  - `入力: 2026-11-29T23:59+09:00 は C-2026-11-16 の 13 日目、2026-11-30T00:00+09:00 は C-2026-11-30 の 0 日目`
  - `入力: 起点より前の 2026-11-15 は C-2026-11-02 の 13 日目`
  - `schedules.test.ts`: `入力: cycle_days [7] と proposal_kinds [content_rewrite] を読む`／`入力: cycle_days に 14 があれば errors`／`入力: kind=builtin に proposal_kinds があれば errors`
  - `engine.test.ts`: `空入力: anchor が無いと cycle_days のジョブは skipped（理由に CONTROL_CYCLE_ANCHOR）`／`入力: 周の 3 日目に cycle_days [7] のジョブは skipped（周の 3 日目は対象外）`／`入力: 手動の起動は cycle_days を見ない`
- [ ] **Step 2:** `config.ts` に `CONTROL_CYCLE_ANCHOR`（任意。`/^\d{4}-\d{2}-\d{2}$/` かつ JST で月曜でなければ「月曜の日付にしてください」）を足し、`cycleAnchor` に入れる。
- [ ] **Step 3:** `calendar.ts` を実装する（`time.ts` の JST の扱いを使う）。
- [ ] **Step 4:** `definitions/proposal.ts` に `export const PROPOSAL_KINDS = [...] as const satisfies readonly ProposalKind[]`（上の 8 値。`email_campaign` を含む）を置き、`ProposalSchema` の `change.kind` をそれで作る（E-13 に `email_campaign` が書けるようになる）。`schedules.ts` の `ScheduleFileSchema` に `cycle_days: z.array(z.number().int().min(0).max(13)).nullable().default(null)` と `proposal_kinds: z.array(z.enum(PROPOSAL_KINDS)).nullable().default(null)`（`kind=agent` のときだけ許す。`superRefine` に足す）を足し、`JobDefinition` に写す。`BUILTIN_JOBS` に `cycle-open`・`cycle-collect`・`cycle-close`・`article-cover`・`campaign-asset-upload` を足し、`contract.ts` の `BuiltinJob` も同じに（ハンドラは Task 4〜7 で足す。それまでは `builtin/index.ts` に「未実装のため見送った」を返す仮のハンドラを置く）。
- [ ] **Step 5:** `engine.ts` の `prepare` で、`trigger === "schedule"` かつ `job.cycleDays` があるとき、`cycleAnchor` が無ければ `{ skip: "CONTROL_CYCLE_ANCHOR が無いため見送った" }`、`cycleOf(now).day` が含まれなければ `{ skip: "周の <n> 日目は対象外" }`。
- [ ] **Step 6:** `cd backend/control-plane && pnpm typecheck` → エラー 0。
- [ ] **Step 7:** 差分の確認（`git diff --stat`）。

### Task 2: 周と項目の保存（SQLite）と境界の型

**Files:**
- Create: `backend/control-plane/src/store/cycles.ts`
- Modify: `backend/control-plane/src/store/migrations.ts`（末尾に 2 本目の要素を足す）、`backend/control-plane/src/contract.ts`、`backend/control-plane/src/context.ts`（`EngineContext.cycles`）、`backend/control-plane/src/index.ts`（生成）
- Test: `backend/control-plane/tests/store/cycles.test.ts`

**Interfaces:**
- Consumes: `CycleId`（Task 1）
- Produces（`contract.ts`）:
  - `CycleItemKind = "article" | "campaign" | "code" | "deploy" | "proposal" | "manual"`
  - `CycleItemState = "preparing" | "awaiting_review" | "approved" | "executed" | "confirmed" | "rejected" | "failed_check"`
  - `CycleStage = "collect" | "propose" | "draft" | "review" | "publish" | "evaluate" | "deploy"`（画面の ①〜⑦）
  - `interface CycleItem { itemId: Ulid; cycleId: CycleId; kind: CycleItemKind; stage: CycleStage; sourceRef: string /* 例 "PRP-2026-0012" "strapi:article:<documentId>" "deploy:<sha>" */; proposalId: string | null; title: string; summary: string; evidence: { auditId: string; summary: string }[]; preview: CycleItemPreview; state: CycleItemState; stateReason: string | null; createdAt: string; updatedAt: string; reflectedAt: string | null }`
  - `type CycleItemPreview = { kind: "article"; documentId: string; slug: string; titleText: string; description: string; coverUrl: string | null; bodyMarkdown: string } | { kind: "campaign"; articleDocumentId: string; linkUrl: string; emailId: number; emailSubject: string; emailBody: string; campaignId: number; segmentName: string; segmentCount: number; assets: { name: string; url: string | null }[] } | { kind: "code"; proposalId: string; files: string[]; diffStat: string } | { kind: "deploy"; commitSha: string; distPath: string; lighthouse: { performance: number; accessibility: number; bestPractices: number; seo: number }; changes: string[]; blocked: string | null } | { kind: "proposal"; prNumber: number | null; prState: "open" | "approved" | "merged" | "closed" | null } | { kind: "manual"; description: string }`
  - `interface CycleApproval { itemId: Ulid; action: "approve" | "reject" | "execute"; actor: string; checked: string[]; reason: string | null; at: string }`
  - `CycleStore` のメソッド: `openCycle(cycleId, startsAt, endsAt, manual: boolean): void`（冪等）、`getCycle(cycleId): CycleRow | null`、`listCycles(limit: number): CycleRow[]`、`upsertItem(input: Omit<CycleItem, "itemId" | "createdAt" | "updatedAt" | "state" | "stateReason" | "reflectedAt"> & { state?: CycleItemState }): CycleItem`（`(kind, source_ref)` が一意。既存なら `title`・`summary`・`evidence`・`preview` だけを更新し、`state` は `preparing`→`awaiting_review` の進行だけ許す）、`listItems(cycleId): CycleItem[]`、`getItem(itemId): CycleItem | null`、`transition(itemId, from: CycleItemState[], to: CycleItemState, reason: string | null): boolean`（`from` に無ければ false）、`setReflected(itemId, at): void`、`recordApproval(a: CycleApproval): void`、`listApprovals(itemId): CycleApproval[]`、`closeCycle(cycleId, result: CycleCloseResult): void`
  - `interface CycleCloseResult { reflectedFromProposals: number; reflectedFromKeywords: number; stuck: Record<"no_proposal" | "pr_not_approved" | "awaiting_review" | "not_executed" | "not_deployed", number> }`
  - `CycleRow = { cycleId: CycleId; startsAt: string; endsAt: string; manual: boolean; closedAt: string | null; close: CycleCloseResult | null }`

- [ ] **Step 1（テスト。指示があるとき）:** `cycles.test.ts`: `入力: 同じ source_ref の upsert は 1 件のまま`／`入力: transition は from に無い状態からは false で変えない`／`入力: openCycle を 2 回呼んでも 1 行`／`入力: preparing の項目に state awaiting_review の upsert で進む、approved の項目は戻らない`
- [ ] **Step 2:** `migrations.ts` の `MIGRATIONS` の末尾に、表 `cycles(cycle_id PK, starts_at, ends_at, manual, closed_at, close_json)`・`cycle_items(item_id PK, cycle_id, kind, stage, source_ref, proposal_id, title, summary, evidence_json, preview_json, state, state_reason, created_at, updated_at, reflected_at, UNIQUE(kind, source_ref))`・`cycle_approvals(id INTEGER PK, item_id, action, actor, checked_json, reason, at)` を足す（`CHECK` で 7 状態・6 種類を縛る）。既存の要素は書き換えない。
- [ ] **Step 3:** `store/cycles.ts` を `RunStore` と同じ書き方（行 → 型の変換関数）で実装し、`EngineContext` と `ControlPlaneImpl` に繋ぐ。
- [ ] **Step 4:** `pnpm typecheck` → 0。
- [ ] **Step 5:** 差分の確認。

### Task 3: 承認済み E-13 の選択と、作用のジョブへの受け渡し（`email_campaign` を足す）

**Files:**
- Create: `backend/control-plane/src/cycle/proposals.ts`
- Modify: `backend/control-plane/src/definitions/proposal.ts`（`change.kind` に `email_campaign`）、`backend/control-plane/src/engine.ts`、`docs/proposals/README.md`（種類の表）、`.claude/agents/proposal-writer.md`（`experiment_start` を起票しない・`email_campaign` の条件）
- Test: `backend/control-plane/tests/cycle/proposals.test.ts`、`tests/engine.test.ts`

**Interfaces:**
- Consumes: `CycleStore.listItems`（Task 2）、`JobDefinition.proposalKinds`（Task 1）
- Produces:
  - `listApprovedProposals(mainCheckout: string): Promise<Proposal[]>`（`main` の `docs/proposals/PRP-*.md` のうち `approval.state` が `approved` のもの。`proposal_id` の昇順）
  - `pickNextProposal(proposals: Proposal[], kinds: ProposalKind[], taken: Set<string>): Proposal | null`（`taken` は項目の `proposalId` の集合）
  - エンジンの約束: `job.proposalKinds` があるジョブは、選ばれた E-13 があればプロンプトの末尾に `\n\nPRP: <proposal_id>` を付けて `trigger: "proposal"` で起動し、無ければ `skipped`（「承認済みで未着手の E-13 が無い」）。起動したら `upsertItem` で `preparing` の項目を作る（`kind` は `content_rewrite`→`article`、`email_campaign`→`campaign`、`technical_seo`・`accessibility`・`cta_swap`・`internal_link`→`code`、`sourceRef` は `proposal_id`）。

- [ ] **Step 1（テスト。指示があるとき）:** `proposals.test.ts`: `入力: approved だけを返す（draft・rejected・applied を除く）`／`入力: 項目のある E-13 は選ばない`／`入力: kinds に無い種類は選ばない`／`入力: 最も古い proposal_id を選ぶ`。`engine.test.ts`: `入力: proposal_kinds のジョブはプロンプトの末尾に PRP 行が付く`／`空入力: 対象が無ければ skipped`
- [ ] **Step 2:**（`email_campaign` は Task 1 の `PROPOSAL_KINDS` で足し済み。`experiment_start` は残す）
- [ ] **Step 3:** `proposals.ts` を実装（`parseProposal` を使う。読めないファイルは WARN で飛ばす）。
- [ ] **Step 4:** `engine.ts` の `prepare` の agent の分岐で、上の約束を実装する。
- [ ] **Step 5:** `proposal-writer.md` を直す: `experiment_start` を起票しない（AB テストは扱わない、2026-11-09）。`email_campaign` は「読み手が介護・障がい福祉の法人・事業所の課題で、根拠の E-12 がある」ときに起票し、`target.entity` に `mautic_segment`、`target.identifier` に既存のセグメントの名前を書く。`docs/proposals/README.md` の種類の表に `email_campaign`（適用の主体: エージェントが未公開で作り、公開〈送信〉は人）を足す。
- [ ] **Step 6:** `pnpm typecheck` → 0。
- [ ] **Step 7:** 差分の確認。

### Task 4: エージェント（`campaign-planner` 新規・`content-writer`／`design-implementer` の E-13 モード）とフックの追加の守り

**Files:**
- Create: `.claude/agents/campaign-planner.md`
- Modify: `.claude/agents/content-writer.md`、`.claude/agents/design-implementer.md`、`backend/control-plane/src/runner/hooks.ts`、`backend/control-plane/src/runner/agent.ts`（ガードにエージェント名を渡す）
- Test: `backend/control-plane/tests/runner/hooks.test.ts`

**Interfaces:**
- Produces:
  - `GuardPaths` に `agentName: string | null` を足す
  - `inspectAgentSpecific(agentName: string | null, toolName: string, toolInput: unknown, paths: GuardPaths): string | null`（`hooks.ts`。`inspectToolCall` の後に呼ぶ）。規則:
    - `campaign-planner`: `mcp__mautic-prod__mautic_create_record` は `resource` が `emails` か `campaigns` のときだけ。`payload.isPublished` が true なら拒否。`campaigns` の `payload.events[*].type` は `email.send` と待ち（作る人が Mautic の API で待ちの型名を確かめて定数にする）だけ。`mcp__mautic-prod__mautic_update_record`・`mautic_delete_record` は拒否。書き込み系のファイルツールは `campaign-assets/` の下だけ。`mcp__strapi-prod__` の `publish_*`・`delete_*` は拒否（定義に無くても念のため）
    - `design-implementer`: 書き込み系のファイルツールは `frontend/verdant-virgo/src/` の下だけ
- `campaign-planner.md` の frontmatter: `tools: Read, Glob, Grep, Write, Edit, WebSearch, WebFetch, mcp__mautic-prod__mautic_list_records, mcp__mautic-prod__mautic_get_record, mcp__mautic-prod__mautic_list_lookup, mcp__mautic-prod__mautic_create_record, mcp__strapi-prod__list_article, mcp__strapi-prod__get_article, mcp__strapi-prod__create_article`、`model: sonnet`。本文は spec 5.8・5.8.1 の規則をそのまま手順にする（1 回 1 件の E-13、記事の本文＝1 次資料のまとめ・`## 出典`・制度の年度・断定しない、メールは要点と UTM 付きリンク〈`utm_source=mautic&utm_medium=email&utm_campaign=<proposal_id>`〉だけ、キャンペーンは完成品で未公開、Plugin は Agent Plugins 1.0 の構成と `name` の制約・`license: "MIT"`・利用者の個人情報を扱わせない・外部送信をしない、`manifest.yaml` の形、`SUMMARY:` に作った ID〈記事の documentId・メール ID・キャンペーン ID〉を書く）。
- `content-writer.md`: 「E-13 モード」の節を足す（`PRP: <id>` があれば、`docs/proposals/<id>.md` を読み、`content_rewrite` で `target.identifier` の記事だけを `update_article` で下書きとして更新。企画の経路の規則は E-13 モードでは使わない）。
- `design-implementer.md`: `PRP: <id>` があれば、その E-13 の `change.description` を仕様として、`frontend/verdant-virgo/src/` に差分を作る。`SUMMARY:` に変えたファイルを列挙する。

- [ ] **Step 1（テスト。指示があるとき）:** `hooks.test.ts`: `入力: campaign-planner の isPublished true の作成は拒否`／`入力: campaign-planner の segments の作成は拒否`／`入力: campaign-planner の campaign-assets 外への Write は拒否`／`入力: design-implementer の src 外への Edit は拒否`／`入力: 他のエージェントは従来どおり`
- [ ] **Step 2:** `hooks.ts`・`agent.ts` を実装。
- [ ] **Step 3:** 3 つの定義ファイルを書く。`ops/mcp-registry.yaml` は既存の `mautic-prod`・`strapi-prod` で足りるので変えない（`ops/README.md` の「MCP の登録表」の「`lead-ops` だけが使う」を「`lead-ops` と `campaign-planner`」に直す）。
- [ ] **Step 4:** `pnpm typecheck` → 0。
- [ ] **Step 5:** 差分の確認。

### Task 5: 公開とマージの検知 → ビルドと計測 → `deploy` の項目（`published-article-check` の実装）と配信のコマンド

**Files:**
- Create: `backend/control-plane/src/integrations/strapi.ts`、`backend/control-plane/src/builtin/published-article-check.ts`、`backend/control-plane/src/cycle/commands.ts`
- Modify: `backend/control-plane/src/builtin/simple.ts`（雛形を消す）、`backend/control-plane/src/builtin/index.ts`、`backend/control-plane/src/builtin/checkout-job.ts`（ビルド用の env を足す関数）、`backend/control-plane/src/config.ts`、`frontend/verdant-virgo/astro.config.mjs` かブログのインテグレーション（`dist/_build.json` の出力）
- Test: `tests/builtin/published-article-check.test.ts`、`tests/cycle/commands.test.ts`

**Interfaces:**
- Consumes: `CycleStore.upsertItem`（Task 2）、`lighthouse.ts` の部品（`runPnpmScript`・`withChildHome`）
- Produces:
  - `ControlPlaneConfig.strapi: { baseUrl: string; readToken: string; writeToken: string | null } | null`（`CONTROL_STRAPI_URL`・`CONTROL_STRAPI_READ_TOKEN`・`CONTROL_STRAPI_WRITE_TOKEN`。前 2 つはグループ）
  - `ControlPlaneConfig.deploy: { bucket: string; distributionId: string; awsProfile: string } | null`（`CONTROL_DEPLOY_BUCKET`・`CONTROL_DEPLOY_DISTRIBUTION_ID`・`CONTROL_DEPLOY_AWS_PROFILE`。グループ）
  - `StrapiClient`: `listPublishedArticles(signal): Promise<{ documentId: string; slug: string; publishedAt: string; updatedAt: string }[]>`、`getArticle(documentId, status: "draft" | "published", signal)`、`listDraftArticlesWithoutCover(signal)`、`uploadFile(file: { name: string; mime: string; data: Uint8Array }, signal): Promise<{ id: number; url: string }>`、`setArticleCover(documentId, fileId, signal)`、`attachArticleFile(documentId, fileId, signal)`（後ろの 3 つは `writeToken` が要る。無ければ `IntegrationError`）
  - `deployCommands(input: { distPath: string; bucket: string; distributionId: string; awsProfile: string }): string[]`（`cloud/README.md` の配信の手順と同じ順: `aws sso login --profile <p>`、`aws s3 sync "<dist>/" s3://<bucket> --exclude '*' --include '_astro/*' --cache-control 'public,max-age=31536000,immutable' --profile <p>`、`aws s3 sync "<dist>/" s3://<bucket> --exclude '_astro/*' --delete --cache-control 'public,max-age=0,must-revalidate' --profile <p>`、`aws cloudfront create-invalidation --distribution-id <id> --paths '/*' --profile <p>`）
  - `kv` のキー: `published-article-check:snapshot`（公開済みの一覧の JSON）、`published-article-check:deployed-sha`
- 振る舞い（spec 5.6）: 差分（新規・更新・消えた記事、または `main` の HEAD の変化）があるときだけ、`main` のチェックアウトの `frontend/verdant-virgo` で `pnpm lh` を、`SITE_URL`・`STRAPI_URL`・`STRAPI_API_TOKEN`（`readToken`）・`BUILD_COMMIT_SHA`（HEAD）を足した env で実行し、`.lighthouseci` の中央値から 4 指標を取り、`deploy` の項目（`sourceRef` は `deploy:<sha>:<snapshot のハッシュ>`）を `awaiting_review` で作る。SEO が 1.0 未満なら `preview.blocked` に理由を入れる。スナップショットは項目を作れたときだけ保存する（失敗したら次回も差分として拾う）。`deployed-sha` は Task 8 の `deploy` の確認で更新する。
- Astro: `BUILD_COMMIT_SHA` があれば `dist/_build.json` に `{ "commit": "<sha>", "builtAt": "<ISO>" }` を書く（無ければ書かない）。

- [ ] **Step 1（テスト。指示があるとき）:** `commands.test.ts`: `入力: 4 本のコマンドが cloud/README の順で、_astro を先に、--delete は 2 本目だけ`。`published-article-check.test.ts`: `サーバ: 前回と同じ一覧と同じ HEAD なら success で何もしない`／`サーバ: 記事が消えたら差分あり`／`入力: SEO 0.98 なら blocked で commands が空`／`空入力: strapi の設定が無ければ skipped`
- [ ] **Step 2:** `config.ts` に 2 グループを足す（`groupIssues` を使う）。`missingConfigFor("published-article-check")` は `CONTROL_STRAPI_URL`・`CONTROL_STRAPI_READ_TOKEN`・`SITE_URL` を挙げる。
- [ ] **Step 3:** `strapi.ts`（`integrations/http.ts` の `fetchJson` を使う。Strapi 5 の REST。`status=draft` の指定）、`commands.ts`、`published-article-check.ts` を実装し、`simple.ts` の雛形を消して `index.ts` を差し替える。
- [ ] **Step 4:** Astro の `_build.json` の出力を足す（Astro のインテグレーションの `astro:build:done`。既存の `modules/blog/integration.ts` の書き方に合わせる）。
- [ ] **Step 5:** `pnpm typecheck`（control-plane と verdant-virgo の `pnpm exec astro check` は実行しない＝ビルドに当たらない範囲で `tsc --noEmit` があればそれ）→ 0。
- [ ] **Step 6:** 差分の確認。

### Task 6: アイキャッチ画像（`article-cover`）

**Files:**
- Create: `backend/control-plane/src/integrations/openai-image.ts`、`backend/control-plane/src/builtin/article-cover.ts`、`ops/prompts/article-cover.md`
- Modify: `backend/control-plane/package.json`（`pnpm add openai`）、`config.ts`、`builtin/index.ts`
- Test: `tests/builtin/article-cover.test.ts`

**Interfaces:**
- Consumes: `StrapiClient.listDraftArticlesWithoutCover`・`uploadFile`・`setArticleCover`（Task 5）
- Produces:
  - `ControlPlaneConfig.openai: { apiKey: string; imageModel: string; imageSize: string; maxPerRun: number } | null`（`OPENAI_API_KEY`・`CONTROL_OPENAI_IMAGE_MODEL`・`CONTROL_OPENAI_IMAGE_SIZE`・`CONTROL_COVER_MAX_PER_RUN`〈既定 3〉。モデルとサイズの既定値は、実装の前に OpenAI の公式ドキュメント〈context7 か Web〉で現行の画像モデルと横長のサイズを確かめて決め、`config.ts` のコメントに確かめた日付を書く）
  - `generateCoverImage(client: OpenAI, prompt: string, model: string, size: string, signal): Promise<Uint8Array>`
  - `buildCoverPrompt(template: string, article: { title: string; description: string }): string`（雛形の `{{title}}`・`{{description}}` を置き換えるだけ。雛形は `main` の `ops/prompts/article-cover.md`。雛形に「文字・人物・ロゴ・商標を入れない」「ブランドの色調」を固定で書く）
- 振る舞い: 下書きで `cover` が空の記事を古い順に `maxPerRun` 件まで。生成 → アップロード → `setArticleCover`。`writeToken` が無い、または `setArticleCover` が権限で失敗したら、アップロードまでにして `targetIds` に `cover-pending:<documentId>:<fileId>` を残す（Task 7 の `cycle-collect` がそれを `article` の項目の手順「表紙に結ぶ」にする）。記事ごとの失敗は続行し、全件失敗なら `failure`、一部なら `partial`。

- [ ] **Step 1（テスト。指示があるとき）:** `article-cover.test.ts`（OpenAI と Strapi はモック）: `入力: 2 件なら 2 回生成して結ぶ`／`入力: maxPerRun 1 なら 1 件だけ`／`サーバ: 結ぶのが 403 ならアップロードまでで cover-pending を残す`／`空入力: openai の設定が無ければ skipped`
- [ ] **Step 2:** 依存を足し、実装する。プロンプトの雛形を書く。
- [ ] **Step 3:** `pnpm typecheck` → 0。
- [ ] **Step 4:** 差分の確認。

### Task 7: キャンペーンの配布物（`campaign-asset-upload`）と、公開サイトでの zip・PDF の配布（DD-05 1.5.3 の変更）

**Files:**
- Create: `backend/control-plane/src/builtin/campaign-asset-upload.ts`、`ops/schemas/agent-plugins-1.0.0/plugin.schema.json`（https://agent-plugins.org/schemas/1.0.0/plugin.schema.json の写し。先頭のコメントは JSON に書けないので、隣に `SOURCE.md`〈取得元と取得日〉を置く）
- Modify: `backend/control-plane/package.json`（`pnpm add fflate ajv playwright-core`）、`builtin/index.ts`、`frontend/verdant-virgo/src/modules/blog/lib/articles.ts`（`assertImage` の隣に配布ファイルの扱い）とブログの描画（ダウンロードのリンク）
- Test: `tests/builtin/campaign-asset-upload.test.ts`

**Interfaces:**
- Consumes: `StrapiClient.uploadFile`・`attachArticleFile`（Task 5）
- Produces:
  - `validatePlugin(dir: string, schema: object): Promise<string[]>`（違反の一覧。空なら通過。`plugin.json` のスキーマ検証、`name` の制約、`skills/*/SKILL.md` の frontmatter に `name`・`description` があること、`LICENSE` があること）
  - `packageAssets(dir: string): Promise<{ name: string; mime: "application/zip" | "application/pdf"; data: Uint8Array }[]>`（`manifest.yaml` に従う。`plugin/` は zip、`summary.md` は PDF）
  - 処理の対象: 作業ツリーの `campaign-assets/<proposal_id>/` のうち、`manifest.yaml` があり、`kv` の `campaign-asset-upload:done:<proposal_id>` が無いもの。成功したら `kv` に記録し、`targetIds` に `asset:<proposal_id>:<fileId>` を残す
  - PDF は `playwright-core` の Chromium（`PLAYWRIGHT_BROWSERS_PATH` は builtin `a11y` と同じ実ホームの `~/.cache/ms-playwright`）で、`summary.md` を最小の HTML にして印刷する。Chromium が無ければ PDF だけ見送る（zip は続ける）
  - 大きさの上限 20 MB（超えたらアップロードしない）
- Astro（DD-05 1.5.3 の変更）: 配布ファイル（`mime` が `application/zip` か `application/pdf`）はビルド時に Strapi から取得して `dist/files/<hash>/<name>` に置き、ページからはそのパスでリンクする。20 MB を超えたら、または他の `mime`（動画など）は従来どおり `StrapiBuildError`。1.5.4（`dist/` に Strapi・S3 の URL が残らない）の検査は変えない。

- [ ] **Step 1（テスト。指示があるとき）:** `入力: name に大文字がある plugin.json は違反`／`入力: LICENSE が無ければ違反`／`入力: 違反があればアップロードしない`／`入力: done の記録がある proposal は飛ばす`／`入力: 20 MB を超える zip はアップロードしない`
- [ ] **Step 2:** スキーマの写しを置き（WebFetch で取得）、実装する。
- [ ] **Step 3:** Astro の変更を入れる。
- [ ] **Step 4:** `pnpm typecheck` → 0。
- [ ] **Step 5:** 差分の確認。

### Task 8: 項目を集める・手順を出す・実行の確認・反映の数え方（`cycle-open`・`cycle-collect`・`cycle-close`）

**Files:**
- Create: `backend/control-plane/src/cycle/checklists.ts`、`cycle/confirm.ts`、`cycle/reflection.ts`、`integrations/mautic.ts`、`builtin/cycle.ts`、`ops/approval-checklists.yaml`
- Modify: `cycle/commands.ts`（種類ごとの手順）、`integrations/github.ts`（`getPullRequest`）、`config.ts`（Mautic の読み取り・作業場の合わせ）、`builtin/index.ts`
- Test: `tests/cycle/confirm.test.ts`、`tests/cycle/reflection.test.ts`、`tests/builtin/cycle.test.ts`

**Interfaces:**
- Consumes: Task 2〜7 のすべて
- Produces:
  - `ControlPlaneConfig.mautic: { baseUrl: string; clientId: string; clientSecret: string } | null`（`CONTROL_MAUTIC_URL`・`CONTROL_MAUTIC_CLIENT_ID`・`CONTROL_MAUTIC_CLIENT_SECRET`。参照専用ロール）
  - `MauticReader`: `getEmail(id)`・`getCampaign(id)`・`getSegment(id)` → `{ isPublished: boolean; sentCount?: number; name?: string; count?: number }`
  - `GitHubClient.getPullRequest(number): Promise<{ state: "open" | "closed"; merged: boolean; approved: boolean }>`
  - `loadChecklists(mainCheckout: string): Promise<Record<CycleItemKind, { id: string; label: string }[]>>`（`ops/approval-checklists.yaml`。項目の `id` は kebab-case。spec 5.4 の初期値を書く。`proposal` と `deploy` 以外の種類の確認項目が空なら読み込みの誤り）
  - `stepsFor(item: CycleItem, ctx: { siteUrl: string; strapiAdminUrl: string; mauticAdminUrl: string; deploy: ControlPlaneConfig["deploy"]; worktree: string; issueNumber: number | null; deployConfirmedUrls: Set<string> }): { text: string; command: string | null }[]`（`commands.ts`。spec 5.3 の表の「OK の後に表示する手順」。`campaign` の ③ は `deployConfirmedUrls` に記事の URL があるときだけ。`code` は作業場で `git fetch origin && git switch -c <issue>-feature-<proposal_id> origin/main`・項目のファイルだけの `git add`・`git commit -m "mod: <title>"`・`gh pr create`、それに人が測る `pnpm lh`・`pnpm a11y:ci`。`deploy` は `deployCommands` の 4 本と、確認の後に「含まれる E-13 の `applied_at` を記録する」〈対象の `docs/proposals/<id>.md` と書く値。spec 5.6〉。`deploy` の `preview.blocked` があれば手順は空で理由だけ）
  - `confirmItem(item: CycleItem, deps): Promise<{ ok: true } | { ok: false; reason: string }>`（`confirm.ts`。`article`: 公開版の `publishedAt` がある／`campaign`: 記事の URL が 200・メールとキャンペーンの `isPublished`／`code`: PR が merged／`deploy`: `SITE_URL/_build.json` の `commit` が一致し、`changes` の URL が 200（確認できたら `kv` の `deployed-sha` を更新）／`manual`: 常に ok〈人の申告〉）
  - `countReflection(items: CycleItem[], cycle: CycleRow): CycleCloseResult`（spec 5.10・5.11 の 2: `reflectedAt` がこの周の期間にある E-13 由来とキーワード由来を分けて数え、`manual` は除く。止まっている場所の内訳）
  - builtin:
    - `cycle-open`: 今日の周を `openCycle`。作業場（`CONTROL_WORKTREE`）に未コミットの変更が無ければ `git -C <worktree> fetch origin` と `git -C <worktree> checkout --detach origin/main`（`child_process.spawn`。シェルを通さない）。あれば合わせず、要約に「作業場に未コミットの変更があるため合わせなかった」。前の周が閉じていなければ `countReflection` で閉じる
    - `cycle-collect`: 今の周に、(1) `docs/proposals` の draft／PR 中の E-13 を `proposal`（PR の状態を `getPullRequest` で）、(2) 承認済みの `config_change` を `manual`、(3) 作用のジョブの E-15（`trigger: "proposal"`）の `targetIds` と `SUMMARY` から `article`・`campaign`・`code` の `preview` を埋めて `awaiting_review` に、(4) キーワードの経路の下書き（`content-writer` の通常の実行の `targetIds`）を `article`（`sourceRef` は `strapi:article:<documentId>`）に、(5) `cover-pending`・`asset:` の印を該当の項目の手順に、(6) `executed` の項目を `confirmItem` にかけて `confirmed`／`failed_check` にし、`confirmed` で公開サイトに出るもの（`deploy` に含まれた `article`・`code`、`campaign`）の `reflectedAt` を記録する。差し戻しの理由を作業場の `docs/cycles/<cycleId>.md` に個人情報を含まない要約で書き出す
    - `cycle-close`: 周の 13 日目に `countReflection` で閉じ、両方が 0 なら `config.status` があれば `sendNotifications`（件名「[ComeGin 改善ループ] この周は反映できなかった」、本文に内訳と画面の URL）。`config.status` が無ければ要約に「知らせの設定が無い」と書いて success
- [ ] **Step 1（テスト。指示があるとき）:** `confirm.test.ts`: `サーバ: publishedAt が null なら failed_check`／`サーバ: _build.json の SHA が違えば failed_check`／`サーバ: campaign の記事 URL が 404 なら failed_check`／`サーバ: PR が closed で未マージなら failed_check`。`reflection.test.ts`: `入力: 前の周に起票し今の周に配信した E-13 は今の周に数える`／`入力: manual は数えない`／`入力: キーワード由来だけでも 0 件ではない`。`cycle.test.ts`: `入力: 作業場に未コミットの変更があれば合わせない`／`入力: 両方 0 件なら知らせを 1 通送る`
- [ ] **Step 2:** `approval-checklists.yaml` に spec 5.4 の初期値（`campaign` は 5.8.1 の項目を含む）を書く。
- [ ] **Step 3:** 上のファイルを実装する。
- [ ] **Step 4:** `pnpm typecheck` → 0。
- [ ] **Step 5:** 差分の確認。

### Task 9: 画面向けの操作（`ControlPlane` のメソッド）

**Files:**
- Create: `backend/control-plane/src/cycle/service.ts`
- Modify: `backend/control-plane/src/contract.ts`（`ControlPlane` にメソッド、`CycleView`）、`backend/control-plane/src/index.ts`
- Test: `tests/cycle/service.test.ts`

**Interfaces:**
- Consumes: Task 2・8
- Produces（`contract.ts`）:
  - `interface CycleView { cycle: CycleRow | null /* 設定が無いときは null */; reason: string | null; stages: { stage: CycleStage; status: "done" | "awaiting" | "not_started" | "stuck"; count: number; jobIds: string[] }[]; items: (CycleItem & { checklist: { id: string; label: string }[]; steps: { text: string; command: string | null }[]; approvals: CycleApproval[] })[]; summary: { proposals: number; reflected: number; awaiting: number; rejected: number; stuck: number; keywordReflected: number }; previousVerification: { proposalId: string; state: string; result: string | null }[] }`
  - `ControlPlane` に: `getCycle(cycleId?: CycleId): Promise<CycleView>`（省略時は今日の周）、`listCycles(): Promise<CycleRow[]>`、`approveCycleItem(itemId: Ulid, checked: string[], actor: string): Promise<CycleView>`（`awaiting_review` からだけ。`checked` が定義の項目の集合と一致しなければ `ControlPlaneInputError`）、`rejectCycleItem(itemId: Ulid, reason: string, actor: string): Promise<CycleView>`（理由は 1〜500 文字。`redactSummary` を通して保存）、`markCycleItemExecuted(itemId: Ulid, actor: string): Promise<{ accepted: boolean }>`（`approved`・`failed_check` から `executed` にし、確認を非同期で始める）、`startCycle(actor: string): Promise<CycleView>`（今日の周を `manual: true` で開く）
  - `proposal` の項目は `approveCycleItem` を受け付けない（`ControlPlaneInputError`「改修案の承認は GitHub の PR で行う」）
- [ ] **Step 1（テスト。指示があるとき）:** `入力: checked が定義の項目と一致しなければ ControlPlaneInputError`／`入力: proposal の項目は承認できない`／`入力: approved でない項目は executed にできない`／`入力: 差し戻しの理由のメールアドレスは伏せ字で保存`
- [ ] **Step 2:** `service.ts` を実装し、`ControlPlaneImpl` に繋ぐ。`actor` は next-js のセッションのメール（Task 10 で渡す）。
- [ ] **Step 3:** `pnpm typecheck` → 0。
- [ ] **Step 4:** 差分の確認。

### Task 10: 監視アプリの「改善ループ」画面と API

**Files:**
- Create: `frontend/next-js/app/(console)/cycle/page.tsx`、`app/(console)/cycle/[cycleId]/page.tsx`、`app/api/cycle/route.ts`（GET 今の周・POST 周を始める）、`app/api/cycle/[cycleId]/route.ts`（GET）、`app/api/cycle/items/[itemId]/route.ts`（POST `{ action: "approve", checked } | { action: "reject", reason } | { action: "execute" }`）、`components/cycle/CycleView.tsx`・`CycleStageNav.tsx`・`CycleItemPanel.tsx`・`CycleSummaryHeader.tsx`・`CommandList.tsx`
- Modify: `components/common/navigation.ts`（「改善ループ」を先頭近くに）、`components/layout/routes.ts`（`HelpId` に `cycle`、パンくず）、`components/layout/labels.ts`（段階と状態の表示名）、`lib/ids.ts`（ULID・周 ID の形）、ヘルプ（`components/jobs/help.tsx` の書き方に倣う）
- Test: `frontend/next-js/tests/…`（既存の単体テストの置き場に合わせる）、`e2e/cycle.spec.ts`（指示があるとき）

**Interfaces:**
- Consumes: Task 9 の `ControlPlane` のメソッドと型（`control-plane` パッケージから import）
- 画面（spec 5.5・レイアウト A）: 上に `CycleSummaryHeader`（周の ID と期間・「改修案 n 件のうち反映済み a・承認待ち b・差し戻し c・止まっている d」・キーワード由来の反映・前の周の 30 日後の判定・反映 0 件の警告〈Cloudscape の `Alert type="warning"`〉・「この周を始める」）。左に `CycleStageNav`（①〜⑦。状態と件数。`SideNavigation` か `Steps` 風の縦の一覧）。右に選んだ段階の概要（`jobIds` のジョブの `overview` とジョブ詳細へのリンク）と項目の一覧 → 開くと `CycleItemPanel`（概要・根拠のシグナルの要約・プレビュー〈記事は `Markdown` 部品と画像、メールは件名と本文、差分はファイルの一覧〉・確認項目の `Checkbox`〈全部入れるまで OK を `disabled`〉・OK・差し戻す〈理由の `Textarea` の `Modal`〉・OK の後は `CommandList`〈コマンドは `CopyToClipboard`〉と「実行した」・確かめた結果）
- API は `withControlPlane` を使い、本文は zod で検証。`actor` はセッションのメール（`lib/session.ts` から）。
- `AutoRefresh` で 30 秒ごとに再取得（`executed` の確認の結果を拾う）。
- [ ] **Step 1（テスト。指示があるとき）:** API の単体テスト: `入力: action approve で checked が配列でなければ 400`／`入力: 未ログインは 401`。E2E（指示があるとき。E2E のサンドボックス 3201）: 「確認項目を全部入れるまで OK が押せない」「OK の後にコマンドが出る」。
- [ ] **Step 2:** API と画面を実装する（既存の `jobs` の画面と同じ部品・書き方）。
- [ ] **Step 3:** `cd frontend/next-js && pnpm typecheck && pnpm lint` → エラー 0。
- [ ] **Step 4:** 差分の確認。

### Task 11: 定期実行の定義・確認項目・設定（ops・setup・onprem・cloud）

**Files:**
- Create: `ops/schedules/cycle-open.yaml`・`cycle-collect.yaml`・`cycle-close.yaml`・`cycle-apply-content.yaml`・`cycle-apply-code.yaml`・`cycle-campaign.yaml`・`campaign-asset-upload.yaml`・`article-cover.yaml`
- Modify: `ops/schedules/published-article-check.yaml`（`overview`・`io` を実装に合わせる）、`ops/README.md`（一覧・時刻の表・「定期実行に載せていないエージェント」から `design-implementer` を外す）、`frontend/next-js/setup/prod/index.mjs`（新しい変数をチェックアウトの `.env` に書く。秘密値は `prod.conf`／状態ファイルから、無ければ止まる id を出して案内）、`frontend/next-js/.env.example`、`setup/manual-steps.md`（作業場の作り方を 6 節の隣に、OpenAI のキー・Strapi のトークン 2 つ・Mautic の参照用の認証情報の発行、`CONTROL_CYCLE_ANCHOR` の決め方）、`setup/00-setup-overview.md`、`setup/status/steps.mjs`（新しい手順の項目）、`frontend/next-js/setup/index.mjs` と `setup/` の worktree の確認（作業場・main のチェックアウト・開発のリポジトリの 3 つが互いに違うこと）、`onprem/README.md`（チェックアウトの `.env` の表に新しい変数、「定期実行を段階的に有効にする」に周のジョブ）、`cloud/README.md`（`CONTROL_DEPLOY_BUCKET`・`CONTROL_DEPLOY_DISTRIBUTION_ID` をどのスタックの出力から写すか。`CONTROL_DEPLOY_AWS_PROFILE` は人の SSO のプロファイル名で、監視アプリは値をコマンドに埋めるだけ）
- Test: `setup/tests/…`（既存の `worktree-paths.test.mjs` の拡張。指示があるとき）

**定義の値（すべて `enabled: false`。時刻は 0〜8 時の窓の既存の表と重ならないように置く。目安）:**

| id | kind | cron | 欄 |
|---|---|---|---|
| `cycle-open` | builtin `cycle-open` | `0 0 * * 1`（月曜 00:00。周の 0 日目でなければ処理の中で何もしない＝`cycle_days` は builtin には使えないので処理側で判定） | `timeout_sec: 300` |
| `cycle-collect` | builtin `cycle-collect` | `0 7 * * *` | `timeout_sec: 600` |
| `cycle-close` | builtin `cycle-close` | `30 7 * * 0`（日曜。13 日目でなければ処理の中で何もしない） | `timeout_sec: 300` |
| `cycle-apply-content` | agent `content-writer` | `30 6 * * *` | `proposal_kinds: [content_rewrite]`、`timeout_sec: 1200`、`max_turns: 60` |
| `cycle-apply-code` | agent `design-implementer` | `0 5 * * 2-6`（火〜土。05:00〜05:25 は i13 の前で空いている時刻を作る人が確かめる） | `proposal_kinds: [technical_seo, accessibility, cta_swap, internal_link]`、`timeout_sec: 1500` |
| `cycle-campaign` | agent `campaign-planner` | `0 4 * * 2`（火曜。観測 4 本の 04:00 と同時刻だが別のエージェントで書き先も別。重ねたくなければ作る人がずらす） | `cycle_days: [8]`、`proposal_kinds: [email_campaign]`、`timeout_sec: 1800`、`max_turns: 80` |
| `campaign-asset-upload` | builtin | `0 6 * * 2` | `after: [cycle-campaign]`、`timeout_sec: 600` |
| `article-cover` | builtin | `0 3 * * 0,2-6`（月曜以外。月曜 03:00〜03:30 の RDS の保守の窓を避ける） | `timeout_sec: 900` |

- `cycle-open` と `cycle-close` は builtin なので、`cycle_days` ではなく処理の中で `cycleOf` を見て 0 日目・13 日目以外は `skipped`（「周の <n> 日目」）を返す（Task 8 の builtin に入れる）。
- 各定義に `overview`・`stage`・`io` を書く（`stage` は既存の 8 値から: `cycle-*` は `monitor`、作用のジョブは `create`、`article-cover`・`campaign-asset-upload` は `create`）。

- [ ] **Step 1:** 定義と `ops/README.md` を書く。
- [ ] **Step 2:** setup・onprem・cloud の手順とスクリプトを直す（新しい止まる id: `next-js-prod:cycle`〈`CONTROL_CYCLE_ANCHOR` が無い〉、`next-js-prod:openai`、`next-js-prod:strapi-tokens`、`next-js-prod:mautic-reader`、`next-js-prod:deploy-values`、`next-js-prod:agent-worktree`。各 id を `setup/manual-steps.md` の早見表に足す）。
- [ ] **Step 3:** `node setup/setup.mjs --target dev --check`（読み取りだけ）で構文の誤りが無いことを確かめる。
- [ ] **Step 4:** 差分の確認。

### Task 12: 正本の文書と ADR

**Files:**
- Modify: `docs/RequirementDefinition/AA/05-application-decisions.md`（**ADR-31**: 改善ループの周と承認の画面〈承認は監視アプリ、OK の後は手順の表示まで、2 週間、AB テストを作らない、エージェント専用の作業場〉。**ADR-32**: キャンペーンのコンテンツは Strapi で配り Mautic はリンク、zip・PDF を `dist/` に取り込む〈DD-05 1.5.3 の変更〉、Plugin は Agent Plugins 1.0・MIT）、`AA/04-recursive-improvement-loop.md`（2.2 の表に `email_campaign`、5 節の現状に周の仕組み）、`TA/07-onprem-control-plane.md`（3.5 の定期実行、7 節の手順 4「監視アプリに表示」の実装、9 節の「承認して配信の操作を置くか」を「手順の表示まで」で決着）、`DetailedDesign/05-build-and-delivery-flows.md`（1.5.3・3.2・5 節）、`DetailedDesign/06-proposal-loop-flows.md`（作用の流れ）、`backend/control-plane/README.md`（新しい builtin・設定・フックの規則）、`.claude/CLAUDE.md`（エージェント定義 12 本 → 13 本）
- [ ] **Step 1:** 上の文書を spec に合わせて直す（決定は ADR に、経緯は各文書の既存の書き方〈「2026-11-09 に ADR-31 で…」〉に従う）。
- [ ] **Step 2:** `rg -n "12 本" .claude docs ops backend/control-plane/README.md` で本数の記述を直し漏れが無いか確かめる。
- [ ] **Step 3:** 差分の確認。

---

## 実行の順番と依存

Task 1 → 2 → 3 → 4 は直列（型とエンジンの約束を積む）。Task 5 → 6・7（Strapi のクライアントを使う）。Task 8 は 2〜7 の後、Task 9 は 8 の後、Task 10 は 9 の後。Task 11・12 は 10 の後（実装に合わせて書く）。

## 本番で 1 周を通す前に人が行うこと（Task 11 の手順に書く）

1. エージェント専用の作業場を作り、`CONTROL_WORKTREE` を向ける。
2. OpenAI の API キー、Strapi のトークン 2 つ（読み取り・アップロードと下書きの更新）、Mautic の参照用の認証情報を発行し、`prod.conf` 経由で設定する。Strapi のアップロード用のトークンで公開できないことを開発の Strapi で確かめる（spec 5.7）。
3. `CONTROL_CYCLE_ANCHOR` を決める。
4. 定義を PR で `enabled: true` にし、`main` に入れて `CONTROL_MAIN_CHECKOUT` を更新する。
