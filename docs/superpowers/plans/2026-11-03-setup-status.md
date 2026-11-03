# 設定の状況（/setup-status） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監視アプリが本番の設定の状況（`setup` の `check()` ＋ 設定スクリプトが見ていないずれ）を定期的に確かめ、P1〜P15 の地図と正本の手順書の本文を 1 画面に出し、更新が必要・警告をメールで知らせる。

**Architecture:** `setup/` の親スクリプトに機械が読める `--check --json` と構造化の `items` を足し、手順の一覧（カタログ）を `setup/status/` に置く。`backend/control-plane` に `status/` サブシステム（fetch・ずれの確認・子プロセスでの check・評価・保存・SNS の知らせ・手順書の節の読み出し）を足し、`contract.ts` に 3 つのメソッドを足す。`frontend/next-js` に `/setup-status` の画面と API を足す。AWS は新しい読み取り専用の主体、GitHub は読み取り専用のトークンを、子プロセスと control-plane の中だけで使う。

**Tech Stack:** Node 24（`.mjs`）・TypeScript 7（control-plane）・Next.js 16 App Router・Cloudscape・AWS SDK v3（`@aws-sdk/client-sns` を追加）・`react-markdown`＋`remark-gfm`（追加）・AWS SAM（`cloud/stacks/iam.yaml`）・Astro（ビルドの情報）

**Spec:** `docs/superpowers/specs/2026-11-03-setup-status-design.md`（全タスクの前提。各タスクの実装者は spec の該当の節も読む）

## Global Constraints

- 文書・コードコメント・画面の文言・スクリプトのヘルプは日本語。
- **2026-11-03 19:20 にユーザーが単体テストの作成・実行と `pnpm build` を許可した**（`.claude/rules/devops-testing.md`・`build-deploy.md` の明示の指示）。各タスクの「テストを足すなら」の名前と期待値で単体テストを書いて実行する（vitest。control-plane は `tests/status/`、setup は `setup/tests/`）。書き方はメモリの単体テストの決まり（正常系と異常系を分ける・`空入力:`／`入力:`／`サーバ:` の接頭辞・外部はモック・timeout 30s）に従う。結合テストは作らない。**`sam build`・`sam deploy`・本番へのデプロイは許可していない**（Task 9 の `sam validate --lint` だけ）。
- **git の書き込み（commit・push・checkout など）はしない**（`.claude/rules/git.md`）。各タスクの最後は「差分を見せてユーザーにコミットを任せる」。
- pnpm 11。依存の追加は `pnpm-workspace.yaml` の `minimumReleaseAge: 10080`・`trustPolicy: no-downgrade`・`blockExoticSubdeps: true` を緩めずに通る版にする。
- `.env`・`samconfig.toml`・`secrets/` を読まない・書かない（フックが止める）。値の形は `.env.example`・`samconfig.toml.example` で知る。`.env.example` は変数を足すたびに同時に更新する。
- 監視アプリは `127.0.0.1:3200` だけ。新しいポートを使わない。
- 監視アプリの主体 `comegin-prod-control-plane` のポリシーは変えない。
- 状況の確認は本番に書き込まない（状態ファイル・環境変数ファイル・`prod.conf` も書かない）。製品の API を呼ぶモジュールは 1 時間に 1 回まで（「今すぐ確かめる」は除く）。
- 秘密値（`prod.conf`・`prod.state.json` の値、AWS のキー、GitHub のトークン）を、画面・保存・メール・ログ・子プロセスの引数に出さない。
- 手順書の本文と手順の一覧は、承認済みの main のチェックアウト（`CONTROL_MAIN_CHECKOUT`）から読む。追跡しないファイルと突き合わせの基点は作業ツリー（`CONTROL_WORKTREE`）から読む（spec の 2 節）。

## Review Focus

- **AWS・GitHub・本番の製品に届かない／資格情報が無い・期限切れ**: その項目は ✓ ではなく ? で理由付きに出し、1 時間続けばメールが 1 通だけ出る（Task 6・7）。
- **子プロセスの check が途中で落ちる・5 分を超える・stdout に JSON 以外が混ざる**: 落ちたモジュールだけ ? にし、ほかのモジュールの結果は出す。stdout の最後の 1 行だけを JSON として読む（Task 1・6）。
- **秘密値が notes・evidence・例外の文に混ざる**: 保存と画面とメールの前に、`prod.conf` の値と状態ファイルの secret の値・トークンをすべて伏せる（Task 6）。
- **同じ ● が何日も続く**: 「新しく出た」メールは 1 回だけ、まとめは 1 日 1 通。監視アプリを再起動しても、保存した知らせの記録から重複させない（Task 7）。
- **`00-setup-overview.md` を直したのにカタログを直していない**: カタログの検査スクリプトが失敗し、どの段階の何がずれたかを出す（Task 3）。画面は、カタログを読めないとき全体を ? にして理由を出す（Task 8）。

---

## ファイルの構成

| ファイル | 役割 |
|---|---|
| `setup/lib/core.mjs`（変更） | 契約のコメントに `items`。`ctx.WORKTREE`・`ctx.checkOnly`。check のとき `State.set` を禁止 |
| `setup/lib/runner.mjs`（変更） | `--json`・`--phase all`（`--check` のときだけ）・`--skip <id,...>` |
| `setup/status/steps.mjs`（新規） | 手順の一覧（カタログ）。P1〜P15・6 節の項目と、確かめ方・正本の節 |
| `setup/status/verify-steps.mjs`（新規） | カタログと `00-setup-overview.md` のずれを確かめる CLI |
| 各 `setup/index.mjs`（変更） | 読み先を `ctx.WORKTREE` に、`items` を返す（cloud・next-js-prod・mcp-prod）、管理者トークンの ◇（chatwoot-prod・n8n-prod）、check の書き込みを外す |
| `backend/control-plane/src/status/*.ts`（新規） | 状況の確認のサブシステム（下の Task 4〜7 の各ファイル） |
| `backend/control-plane/src/config.ts`・`contract.ts`・`index.ts`（変更） | 設定のグループ `status`、契約のメソッド、起動と停止 |
| `frontend/next-js/app/(console)/setup-status/page.tsx`・`app/api/setup-status/**`・`components/setup-status/*`（新規） | 画面と API |
| `frontend/next-js/components/layout/routes.ts`（変更） | ナビ・パンくず・Tools |
| `cloud/stacks/iam.yaml`・`cloud/template.yaml`（変更） | 管理ポリシー `comegin-prod-status-reader` と出力 |
| `frontend/next-js/setup/prod/index.mjs`（変更） | 新しい `.env` の値と、主体・トークンの確認 |
| `frontend/verdant-virgo/src/modules/build-info/`（新規） | `dist/build-info.json` |
| 文書（変更） | spec の 8 節の一覧 |

---

### Task 1: 設定スクリプトの機械が読める check（`--json`・`--phase all`・`--skip`・`items`・読み取りだけ）

**Files:**
- Modify: `setup/lib/core.mjs`（冒頭の契約のコメント・`State.set`・`createContext`）
- Modify: `setup/lib/runner.mjs`（`parseArgs`・`helpText`・`main` の check の分岐）
- Modify: `setup/README.md`（オプションの表・「モジュールを足すとき」）

**Interfaces:**
- Produces（Task 2・4・6 が使う）:
  - CLI: `node setup/setup.mjs --target prod --check --json --phase all [--skip a,b]`（`frontend.mjs` も同じ）。`--json` と `--phase all` は `--check` のときだけ受け、それ以外は `1` で終わる。
  - stdout の最後の 1 行が次の JSON（ほかの出力はすべて stderr へ。`ctx.log` も `--json` のときは stderr）:
    ```ts
    type SetupCheckReport = {
      version: 1; target: "prod"; script: "setup/setup.mjs" | "setup/frontend.mjs";
      startedAt: string; finishedAt: string; // ISO 8601（+09:00）
      results: Array<{
        moduleId: string; phase: string | null; ok: boolean; notes: string[];
        items: StatusItem[];            // モジュールが返さなければ []
        error: string | null;           // check が投げたときの message（mask 済み）
        skipped: boolean;               // --skip で飛ばした
      }>;
    };
    type StatusItem = {
      key: string;                      // 例 "cloud.sns-subscription"。カタログの probe が参照する
      step: string;                     // 例 "P2"・"P15"・"R1"（6 節）
      level: "ok" | "action" | "warn" | "manual" | "unknown";
      title: string; evidence: string;  // 秘密値なし（mask を通す）
      stopId?: string;                  // 例 "next-js-prod:build"
    };
    ```
  - `ctx.WORKTREE`: 追跡しないファイルと突き合わせの基点。環境変数 `SETUP_WORKTREE`（絶対パス）があればそれ、無ければ `REPO`。
  - `ctx.checkOnly: boolean`（`--check` のとき true）。
  - `--check` のとき `ctx.state.set` は `Error("check の中で状態を書こうとした: <key>")` を投げる（その module の `error` に出る）。

- [ ] **Step 1: `core.mjs` の冒頭のコメントに `items` と `ctx.WORKTREE`・`ctx.checkOnly` の説明を足し、`createContext({ ..., checkOnly })` で受けて `ctx` に載せる。`State` に `readOnly` を足し、`set` で上の例外を投げる。**
- [ ] **Step 2: `runner.mjs` に `--json`・`--phase all`・`--skip` を足す。** `--phase all` は `PROD_PHASES` の全段階（`google`・`operate` を含む）。`--skip` の id は `--only` と同じく `--list` に無ければ `1`。`--json` のとき、人向けの `console.log` は `console.error` に出し、最後に `JSON.stringify(report)` を 1 行だけ stdout に出す。check が投げた例外は `error` に入れて次へ進む（今の `? 確かめられない` と同じ扱い）。終了コードは `0`（check の結果に関わらず）。
- [ ] **Step 3: 確かめる（人の今の使い方が変わっていないこと）**
  Run: `node setup/setup.mjs --target prod --check --phase operate`
  Expected: 今までと同じ人向けの表示（`■ …`・`✓ 用意できている`／`… まだ`）。
- [ ] **Step 4: 確かめる（JSON）**
  Run: `node setup/setup.mjs --target prod --check --json --phase all 2>/dev/null | tail -n 1 | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(r.version, r.results.length, r.results.filter(x=>x.error).map(x=>x.moduleId+":"+x.error))'`
  Expected: `1 <件数>` と、`check の中で状態を書こうとした` を含む error の一覧（Task 2 で直す対象の洗い出し）。ここで出た一覧を Task 2 の作業メモにする。
- [ ] **Step 5: `setup/README.md` のオプションの表に 3 つを足す。差分をユーザーに見せる（コミットはユーザー）。**

テストを足すなら（指示があったとき）: `setup/tests/runner-json.test.mjs` — 「入力: --json を --check なしで渡すと 1 で終わる」「入力: check の中の state.set は error に入り、ほかのモジュールは続く」「サーバ: stdout の最後の行だけが JSON」。

---

### Task 2: 各モジュールの check を状況の確認に耐える形にする

**Files:**
- Modify: `cloud/setup/index.mjs`（`appsWarnings`・`operateWarnings` を項目で返す・`samconfig.toml` を `ctx.WORKTREE` から・DB 作成の確認で状態を書かない）
- Modify: `frontend/next-js/setup/prod/index.mjs`（作業ツリーとの比較・`origin/main` の読み先・`items`）
- Modify: `frontend/verdant-virgo/setup/index.mjs`（同じ場所の検査と読み先）
- Modify: `onprem/setup/index.mjs`（`onprem/*/.env` を `ctx.WORKTREE` から）
- Modify: `backend/chatwoot-system/setup/prod/index.mjs`・`middleware/n8n/setup/prod/index.mjs`（管理者トークンが無いときの扱い）
- Modify: `ops/setup/index.mjs`（`items`。本番の MCP の `dist` がチェックアウトの HEAD より新しいか）
- Modify: Task 1 の Step 4 で `error` に出たほかのモジュール

**Interfaces:**
- Consumes: Task 1 の `StatusItem`・`ctx.WORKTREE`・`ctx.checkOnly`。
- Produces（Task 3 のカタログが参照する `key`）:
  - cloud: `cloud.global-second`（P2）・`cloud.sns-subscription`（P2）・`cloud.ses-production`（P12/P15）・`cloud.ses-domain`（P4）・`cloud.dmarc`（P4）・`cloud.wireguard-ami`（P6）・`cloud.onprem-keys`（P6）・`cloud.smtp-secrets`（P4）・`cloud.deploy-principal`（P12/P15）・`cloud.old-keys`（P15）・`cloud.setup-only-values`（P15）。警告は `level: "warn"`、問題が無いときも `level: "ok"` で同じ `key` を返す。
  - next-js-prod: `next-js-prod.checkout`・`.build`・`.principal`・`.prod-values`・`.systemd`・`.respond`・`.heartbeat-alarm`・`.schedules-enabled`（すべて P14。`stopId` は今の止まる id）。
  - mcp-prod: `mcp-prod.dist`（P10。`backend/chatwoot-mcp`・`backend/mautic-mcp` の `dist` がチェックアウトの HEAD のコミット時刻より新しいか）・`mcp-prod.values`（P10）。
  - chatwoot-prod・n8n-prod: 管理者トークンが要る確認は `key: "<module>.admin-token-checks"`・`level: "manual"`・`evidence: "初期設定用の値（CHATWOOT_ADMIN_TOKEN）を消した後なので確かめない（P15）"`。ほかの確認は続け、`ok` は管理者トークンの無さで false にしない（`mautic-prod` の 11-03 の直し方に合わせる）。

- [ ] **Step 1: `cloud` の警告を `{ key, step, text }` で集め、check は `notes`（今までどおり `! ` 付き）と `items` の両方を返す。`apply` 側の `ctx.warn` の表示は変えない。**
- [ ] **Step 2: `cloud` の DB 作成のタスクの確認は、`ctx.checkOnly` のとき状態に書かずに結果だけ返す。`samconfig.toml` は `join(ctx.WORKTREE, "cloud/samconfig.toml")` から読む（値を出さない今の決まりのまま）。**
- [ ] **Step 3: `next-js-prod`・`verdant-virgo` の「チェックアウトが作業ツリーと同じ場所」の検査を `ctx.WORKTREE` と比べる形にし、`origin/main` の比較と作業ツリーの `.env` の読み先を `ctx.WORKTREE` に。`next-js-prod` は上の `key` で `items` を返す。**
- [ ] **Step 4: `onprem` の `.env` の読み先を `ctx.WORKTREE` に。**
- [ ] **Step 5: `chatwoot-prod`・`n8n-prod` の管理者トークンの扱い（上の Produces）。**
- [ ] **Step 6: `mcp-prod` に `items`（上の Produces）。**
- [ ] **Step 7: 確かめる（作業ツリーから。人の使い方）**
  Run: `node setup/setup.mjs --target prod --check --phase all 2>&1 | grep -c "確かめられない"` と、Task 1 の Step 4 と同じ JSON のコマンド
  Expected: `check の中で状態を書こうとした` が 0 件。cloud・next-js-prod・mcp-prod の `items` が出る。
- [ ] **Step 8: 確かめる（チェックアウトから、作業ツリーを明示して）**
  Run: `SETUP_WORKTREE=$PWD node ~/ComeGin/main-checkout/setup/setup.mjs --target prod --check --json --phase all 2>/dev/null | tail -n 1 | node -e '…上と同じ…'`
  Expected: 「チェックアウトが作業ツリーと同じ場所」「samconfig.toml が無い」で落ちるモジュールが無い。**注意**: チェックアウトは origin/main なので、この作業の差分はまだ入っていない。この Step は、マージの後にユーザーと一緒に行う（それまでは Step 7 だけ）。
- [ ] **Step 9: 差分をユーザーに見せる。**

---

### Task 3: 手順の一覧（カタログ）と、`00-setup-overview.md` とのずれの検査

**Files:**
- Create: `setup/status/steps.mjs`
- Create: `setup/status/verify-steps.mjs`
- Modify: `setup/README.md`（「設定の状況のカタログ」の節）・`setup/00-setup-overview.md`（1 節の地図の表に 1 行、各 P の見出しの直後の HTML コメントは足さない）

**Interfaces:**
- Consumes: Task 2 の `key` の一覧。
- Produces（Task 4〜6 が `import()` で読む。`steps.mjs` は副作用なしの ESM で、`default` を export しない）:
  ```js
  export const CATALOG_VERSION = 1;
  /** 製品の API を呼ぶ（1 時間に 1 回まで）モジュール */
  export const PRODUCT_API_MODULES = ["chatwoot-prod", "mautic-prod", "n8n-prod", "mcp-prod", "openseo"];
  /** @type {Array<{ id: string; title: string; items: CatalogItem[] }>} id は "P1"〜"P15" と "R1"（6 節） */
  export const STEPS = [...];
  // CatalogItem = {
  //   id: string;                       // 段階の中で一意。例 "P12.build"
  //   title: string;                    // 00-setup-overview.md のチェック項目の要約（画面の見出し）
  //   who: "自動" | "人・端末" | "人・画面" | "人・GitHub" | "人・ブラウザ" | "判断";
  //   kind: "検査" | "警告" | "申告" | "未検査" | "判断";
  //   overviewText: string;             // 00-setup-overview.md の該当行に含まれる一意な部分文字列（検査が使う）
  //   probe: { kind: "item"; key: string }
  //        | { kind: "module"; module: string; phase: string }
  //        | { kind: "drift"; id: "site-redeploy" | "n8n-workflows" }
  //        | { kind: "none" };          // ◇（未検査・申告・判断・確かめる手段が無い）
  //   docs: Array<{ file: string; heading: string }>; // 例 { file: "cloud/README.md", heading: "4.14" }
  //   stopId?: string;
  // }
  ```
  - `docs[].heading` は、そのファイルの見出しの行（`#` を除いた文字列）の**先頭に一致する**文字列（例 `"4.14"` は `### 4.14 公開サイトの配信…` に当たる。`onprem/README.md` の「監視アプリ（改善ループ）を本番で動かす」は見出しの文字列そのもの）。
  - CLI: `node setup/status/verify-steps.mjs [--root <dir>]` — 終了コード `0` 一致／`1` 不一致（理由を 1 行ずつ）。

- [ ] **Step 1: `steps.mjs` を書く。** `00-setup-overview.md` の 3 節の P1〜P15 のチェックボックスの行（`- [ ]` と、ラベルの付いた `- ` の行）を 1 行 1 項目にし、6 節の表の各行を `R1` の項目（`kind: "判断"`・`probe: none`）にする。`probe` の決め方: Task 2 の `key` があればそれ、モジュールの止まる id で丸ごと確かめているものは `module`、P12 の「承認済みの main でビルド」「PR をマージするたび…ビルドし直す」は `drift: site-redeploy`、P14 の最後の行（n8n のスケジュールをリポジトリに合わせる）は `drift: n8n-workflows`、〔未検査〕・〔申告〕・判断は `none`。`docs` は各行の「— cloud 4.14」などの参照をそのまま写す（`cloud N`→`cloud/README.md`、`onprem「…」`→`onprem/README.md`、`manual N`→`setup/manual-steps.md`、`setup「…」`→`setup/README.md`、`middleware/…`→そのパス）。
- [ ] **Step 2: `verify-steps.mjs` を書く。** 確かめること: (a) 3 節の各 P の見出し（`### P<n>.`）が `STEPS` にあり逆も同じ、(b) 各項目の `overviewText` がその P の節に 1 回だけ現れる、(c) その P の節のチェックボックスの行の数と項目の数が同じ（`R1` は 6 節の表の行の数）、(d) `docs` の各ファイルが `--root`（既定はリポジトリのルート）にあり、`heading` に先頭一致する見出しが 1 つだけある、(e) `probe.kind === "item"` の `key` が Task 2 の一覧にある（一覧は `steps.mjs` に `KNOWN_ITEM_KEYS` として持つ）。
- [ ] **Step 3: 確かめる**
  Run: `node setup/status/verify-steps.mjs`
  Expected: 終了コード `0`。わざと `overviewText` を 1 つ壊すと `1` で、どの P のどの項目かが出る（確かめたら戻す）。
- [ ] **Step 4: `setup/README.md` に「設定の状況のカタログ」（`00-setup-overview.md` を直したら `steps.mjs` も直し、`verify-steps.mjs` を通す）を足し、`00-setup-overview.md` の 1 節の表に「状況は監視アプリの `/setup-status` で見る」の行を足す。差分をユーザーに見せる。**

---

### Task 4: control-plane の設定・契約・カタログと手順書の読み出し

**Files:**
- Modify: `backend/control-plane/src/config.ts`（グループ `status`）
- Modify: `backend/control-plane/src/contract.ts`（型とメソッド）
- Create: `backend/control-plane/src/status/catalog.ts`
- Create: `backend/control-plane/src/status/docs.ts`
- Modify: `frontend/next-js/.env.example`・`backend/control-plane/README.md`（変数の表）

**Interfaces:**
- Consumes: Task 3 の `steps.mjs` の形。
- Produces:
  - 環境変数（グループ「設定の状況」。`CONTROL_SETUP_STATUS_ENABLED=true` のときだけ残りが必須。`groupIssues` と同じ扱い。既定 `false`）: `CONTROL_SETUP_STATUS_ENABLED`・`CONTROL_STATUS_AWS_CREDENTIALS_FILE`（絶対パス）・`CONTROL_STATUS_AWS_PROFILE`（既定 `default`）・`CONTROL_STATUS_GITHUB_TOKEN_FILE`（絶対パス）・`CONTROL_STATUS_ALERT_TOPIC_ARN`（`arn:aws:sns:` で始まる）・`CONTROL_STATUS_LINK_BASE`（URL。既定 `http://127.0.0.1:3200`）。リージョンは既存の `AWS_REGION`、リポジトリは既存の `GITHUB_REPOSITORY`（無ければ `ComeGin/systematization-of-the-business-foundation`）、公開サイトは既存の `SITE_URL`（`status` が有効なら必須）。
  - `ControlPlaneConfig.status: { awsCredentialsFile: string; awsProfile: string; githubTokenFile: string; alertTopicArn: string; linkBase: string; region: string; repository: string; siteUrl: string } | null`
  - `contract.ts`:
    ```ts
    export type SetupStatusLevel = "ok" | "action" | "warn" | "manual" | "unknown";
    export interface SetupStatusItemView { id: string; title: string; who: string; kind: string; level: SetupStatusLevel;
      evidence: string; stopId: string | null; docs: { file: string; heading: string }[]; checkedAt: string | null; }
    export interface SetupStatusStepView { id: string; title: string; level: SetupStatusLevel; items: SetupStatusItemView[]; }
    export interface SetupStatusView {
      enabled: boolean;                 // false なら steps は空、reason に「本番の監視アプリだけで動く」
      reason: string | null;            // カタログを読めない・設定が無いなど（値なし）
      checkedAt: string | null; nextCheckAt: string | null; running: boolean;
      counts: Record<SetupStatusLevel, number>;
      notifyError: string | null;       // 直近の知らせの送信の失敗（種類だけ）
      steps: SetupStatusStepView[];
    }
    export interface SetupDocSection { file: string; heading: string; markdown: string; }
    // ControlPlane に足す
    getSetupStatus(): Promise<SetupStatusView>;
    refreshSetupStatus(): Promise<{ accepted: boolean }>;   // 確認中なら accepted=false
    readSetupDoc(file: string, heading: string): Promise<SetupDocSection | null>;
    ```
  - `catalog.ts`: `loadCatalog(mainCheckout: string): Promise<Catalog>`（`pathToFileURL(join(mainCheckout, "setup/status/steps.mjs"))` を `import()` し、zod で検証。読み込みのたびに `?t=<mtime>` を付けてキャッシュを避ける）。`Catalog = { version: 1; productApiModules: string[]; steps: CatalogStep[] }`。
  - `docs.ts`: `readDocSection(mainCheckout: string, file: string, heading: string): Promise<SetupDocSection | null>` — `file` は `catalog` の `docs` に現れるものだけ許す（許可リストは呼び出し側が渡す。`..`・絶対パスは null）。見出しの行（`#` の数 n）から、次の n 以下の見出しの直前までを返す。コードブロックの中の `#` は見出しとみなさない。

- [ ] **Step 1: `config.ts` にグループと `status` を足す（`loadControlPlaneConfig` の失敗の出し方は今のまま）。**
- [ ] **Step 2: `contract.ts` に上の型とメソッドを足す（`index.ts` のクラスには Task 6 まで `throw new Error("未実装")` の仮の実装を置かず、Task 6 と同時に足す。型の検査は Task 6 の後にまとめて通す）。**
- [ ] **Step 3: `catalog.ts`・`docs.ts` を書く。**
- [ ] **Step 4: 確かめる**
  Run: `cd backend/control-plane && pnpm typecheck`
  Expected: `index.ts` が `ControlPlane` の新しいメソッドを持たないことだけのエラー（Task 6 で消える）。それ以外は 0。
- [ ] **Step 5: `.env.example` と README の変数の表を更新し、差分をユーザーに見せる。**

テストを足すなら: `tests/status/docs.test.ts` — 「入力: heading '4.14' は '### 4.14 …' から次の '###' の前まで」「入力: '../x.md' は null」「入力: コードブロックの '# ' で切れない」。

---

### Task 5: ずれの確認（main の fetch・公開サイトの再配信・n8n のワークフロー）

**Files:**
- Create: `backend/control-plane/src/status/git-fetch.ts`
- Create: `backend/control-plane/src/status/drift.ts`
- Create: `frontend/verdant-virgo/src/modules/build-info/index.ts`（Astro のインテグレーション。`astro.config.mjs` に登録）
- Modify: `frontend/verdant-virgo/README.md`・`cloud/README.md` の 4.14（同期の前に `dist/build-info.json` があること）

**Interfaces:**
- Consumes: Task 4 の `config.status`・既存の `config.n8nExport`・既存の n8n のワークフローの読み方（`src/definitions/n8n-workflow.ts`・`src/builtin/n8n-export.ts`）。
- Produces:
  - `fetchMain(checkout: string, repository: string, tokenFile: string, signal: AbortSignal): Promise<{ ok: true; head: string } | { ok: false; reason: string }>` — `git -C <checkout> fetch --no-tags origin main` を、トークンを `GIT_CONFIG_COUNT=1`・`GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`・`GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64("x-access-token:" + token)>` の**環境変数**で渡して実行する（引数・URL・`.git/config` に書かない）。`GIT_TERMINAL_PROMPT=0`。成功なら `git rev-parse origin/main`。
  - `buildInfo` の形（公開サイトの `https://<SITE>/build-info.json`）: `{ "commit": "<40 桁>", "builtAt": "<ISO 8601>" }`。ビルドの cwd の `git rev-parse HEAD`。取れなければビルドを止めず `commit: null`。
  - `type DriftResult = { id: "site-redeploy" | "n8n-workflows"; level: SetupStatusLevel; evidence: string }`
  - `checkSiteRedeploy(opts: { checkout: string; siteUrl: string; repository: string; tokenFile: string; signal: AbortSignal }): Promise<DriftResult>` — `build-info.json` を取り、`git -C <checkout> log --format=%H%x09%cI%x09%s <commit>..origin/main -- frontend/verdant-virgo` が 1 件以上なら `action`（evidence に最初と最後のコミットと件数、取れれば PR 番号〈GitHub の `GET /repos/{repo}/commits/{sha}/pulls`〉）、0 件なら `ok`（「配信中のビルド <builtAt>（<commit 7 桁>）以降、公開サイトの変更なし」）。`build-info.json` が 404 なら `action`（「配信中のビルドにビルドの情報が無い。この機能より前のビルド」）。届かなければ `unknown`。
  - `checkN8nWorkflows(opts: { checkout: string; n8n: { baseUrl: string; apiKey: string } | null; signal: AbortSignal }): Promise<DriftResult>` — `origin/main` の `middleware/n8n/workflows/*.json`（`git show origin/main:<path>`）と本番の n8n の同名のワークフローを、`nodes`（名前・型・パラメータ）・`connections`・スケジュールのトリガーの規則で比べる（id・位置・`updatedAt`・資格情報の id は比べない）。違えば `action`（どのワークフローか）、`n8n` が null なら `unknown`（「CONTROL_N8N_EXPORT_* が無い」）。

- [ ] **Step 1: `git-fetch.ts` を書く。**
- [ ] **Step 2: Astro の `build-info` インテグレーションを書き、`astro.config.mjs` に登録する（`astro:build:done` で `dist/build-info.json` を書く。秘密値なし）。**
- [ ] **Step 3: `drift.ts` を書く。**
- [ ] **Step 4: 確かめる**
  Run: `cd backend/control-plane && pnpm typecheck`（Task 4 の既知のエラーだけ）、`cd frontend/verdant-virgo && pnpm astro check`
  Expected: 新しいエラーなし。
- [ ] **Step 5: 文書を更新し、差分をユーザーに見せる。**

テストを足すなら: `tests/status/drift.test.ts` — 「サーバ: build-info が 404 なら action」「入力: commit..origin/main に verdant-virgo の変更が 0 件なら ok」「サーバ: n8n のノードのパラメータだけが違えば action」「サーバ: 位置だけが違えば ok」。

---

### Task 6: 状況の確認の本体（子プロセス・評価・伏せ字・保存・スケジュール）と契約の実装

**Files:**
- Create: `backend/control-plane/src/status/run-check.ts`
- Create: `backend/control-plane/src/status/evaluate.ts`
- Create: `backend/control-plane/src/status/redact.ts`
- Create: `backend/control-plane/src/status/store.ts`
- Create: `backend/control-plane/src/status/service.ts`
- Modify: `backend/control-plane/src/index.ts`（`start`・`stop`・3 つのメソッド）

**Interfaces:**
- Consumes: Task 1 の `SetupCheckReport`、Task 4 の `Catalog`・`config.status`・契約の型、Task 5 の `fetchMain`・`checkSiteRedeploy`・`checkN8nWorkflows`。
- Produces（Task 7・8 が使う）:
  - `runSetupCheck(opts: { mainCheckout: string; worktree: string; status: StatusConfig; script: "setup/setup.mjs" | "setup/frontend.mjs"; skip: string[]; signal: AbortSignal }): Promise<SetupCheckReport | { error: string }>` — `process.execPath` で `<mainCheckout>/<script> --target prod --check --json --phase all [--skip …]` を実行。env は許可リストだけ: `PATH`・`HOME`・`LANG`・`AWS_SHARED_CREDENTIALS_FILE`・`AWS_PROFILE`・`AWS_REGION`・`AWS_CONFIG_FILE=/dev/null`（手元の SSO のプロファイルを使わせない）・`SETUP_WORKTREE`。GitHub のトークンは渡さない。stdout の最後の行を JSON として zod で検証。タイムアウト 5 分。
  - `collectSecrets(home: string): string[]`（`~/.config/comegin/setup/prod.conf` の 8 文字以上の値・`prod.state.json` の `secrets` に載ったキーの値・2 つの資格情報ファイルの中身の値）と `redact(text: string, secrets: string[]): string`（長い値から伏せる。`setup/lib/core.mjs` の `mask` と同じ規則）。
  - `evaluate(catalog: Catalog, reports: ModuleResultWithTime[], drifts: DriftResult[], fetchError: string | null): Omit<SetupStatusView, "enabled" | "reason" | "running" | "nextCheckAt" | "notifyError">` — 規則: `probe.item` は同じ `key` の項目の `level`（無ければ `unknown`「モジュールが項目を返さなかった」）、`probe.module` はそのモジュールと段階の結果（`error` → `unknown`、`!ok` → `action`、`ok` で `! ` の notes あり → `warn`、それ以外 `ok`。evidence は notes を `／` でつないだもの）、`probe.drift` は該当の `DriftResult`（fetch が失敗していれば `unknown`）、`probe.none` は `manual`。段階の `level` は重さ順 `action > warn > unknown > manual > ok`。`ga4`・`next-js-prod` は 2 本の親スクリプトの両方に出るので、`(moduleId, phase)` が同じ結果は `setup/setup.mjs` のほうを使う。
  - `type ModuleResultWithTime = SetupCheckReport["results"][number] & { checkedAt: string }`
  - `StatusStore`（`<dataDir>/setup-status.json`。一時ファイル → rename で書く。600）: `load(): StoredStatus | null`・`save(s: StoredStatus): void`。`StoredStatus = { version: 1; snapshot: …evaluate の戻り値; moduleResults: ModuleResultWithTime[]; productApiCheckedAt: string | null; ledger: NotifyLedger }`（`NotifyLedger` は Task 7）。
  - `SetupStatusService`: `start(): void`（起動の 30 秒後に 1 回、以後 10 分ごと。`unref`）・`stop(): void`・`refresh(): { accepted: boolean }`・`view(): SetupStatusView`。1 回の確認の順: `fetchMain` → 2 つの `runSetupCheck`（`productApiCheckedAt` から 1 時間たっていなければ `PRODUCT_API_MODULES` を `--skip` し、前回の結果を引き継ぐ。`refresh()` のときは飛ばさない）→ 2 つの drift → `redact` → `evaluate` → 保存 → Task 7 の知らせ。確認中の重なりは飛ばす。`config.status` が null なら `view()` は `enabled: false`。
  - `index.ts`: `start()` で `config.status` があれば `SetupStatusService.start()`（`schedulerEnabled` と無関係。0〜8 時の窓に縛らない）。`stop()` で止める。`readSetupDoc` はカタログの `docs` にある `(file, heading)` だけを `readDocSection` に渡す。

- [ ] **Step 1: `redact.ts`・`run-check.ts` を書く。**
- [ ] **Step 2: `evaluate.ts` を書く（純粋な関数。時刻は引数）。**
- [ ] **Step 3: `store.ts`・`service.ts` を書き、`index.ts` に組み込む。ログは `logLine("INFO"|"WARN", "setup-status", …)`（値なし）。E-15 の実行記録には入れない。**
- [ ] **Step 4: 確かめる**
  Run: `cd backend/control-plane && pnpm typecheck && pnpm exec eslint src/status 2>/dev/null || true`
  Expected: 型のエラー 0。
- [ ] **Step 5: 確かめる（読み取りだけで 1 回動かす）** ユーザーの許可を得て `pnpm build` した後、`node -e` で `createControlPlane({ env: { …開発の .env.example の値＋status の値… } })` を作り `refreshSetupStatus()` → 数分後に `getSetupStatus()` を表示する小さなスクリプトを scratchpad に書いて実行する。
  Expected: `steps` が P1〜P15・R1 の 16 個、`counts` の合計が項目の数、`evidence` に `prod.conf` の値が現れない（`grep` で確かめる）。主体とトークンがまだ無ければ、AWS の項目が `unknown` で理由付き。
- [ ] **Step 6: 差分をユーザーに見せる。**

テストを足すなら: `tests/status/evaluate.test.ts` — 「入力: module の error は unknown」「入力: ok で '! ' の notes は warn」「入力: 段階は最も重い level」。`tests/status/redact.test.ts` — 「入力: 短い値が長い値の一部でも長い値が先に伏せられる」。

---

### Task 7: メールでの知らせ（SNS `comegin-ops-alert`）

**Files:**
- Create: `backend/control-plane/src/status/notify.ts`
- Modify: `backend/control-plane/package.json`（`@aws-sdk/client-sns`。ほかの `@aws-sdk/*` と同じ版の範囲 `^3.1141.0`）
- Modify: `backend/control-plane/src/status/service.ts`（呼び出し）

**Interfaces:**
- Consumes: Task 6 の `StoredStatus`・`SetupStatusView`・`redact`。
- Produces:
  - `type NotifyLedger = { lastLevels: Record<string, SetupStatusLevel>; digestSentOn: string | null /* JST の YYYY-MM-DD */; unknownSince: string | null; unknownNotified: boolean }`
  - `planNotifications(prev: NotifyLedger, view: SetupStatusView, now: Date): { messages: Array<{ subject: string; body: string }>; next: NotifyLedger }` — 純粋な関数。規則（spec の 6.2）:
    - 項目が `action` か `warn` に**新しく**なった（`prev.lastLevels[id]` が違う）→ 1 回の確認で 1 通にまとめる。件名 `[ComeGin 設定の状況] 更新が必要 <n> 件・警告 <m> 件`。
    - `action`・`warn` が 1 件以上あり、JST で 09:00 以降、`digestSentOn` が今日でない → まとめ 1 通（件名 `[ComeGin 設定の状況] 毎日のまとめ: …`）。
    - 全体の確認そのものが失敗（AWS・fetch・子プロセス）または `unknown` の項目がある状態が 1 時間以上続き、まだ知らせていない → 1 通（件名 `[ComeGin 設定の状況] 確かめられない状態が続いている`）。`unknown` が 0 になったら `unknownSince`・`unknownNotified` を戻す。
    - `ok` への戻り・`manual` は送らない。
    - 本文: 項目ごとに「段階 ID・見出し・状態・根拠」、最後に `<linkBase>/setup-status?step=<段階 ID>`。本文は送る前に `redact` を通す。SNS のメールの上限（件名 100 文字）を超えたら切る。
  - `sendNotifications(messages, status: StatusConfig): Promise<{ ok: true } | { ok: false; reason: string }>` — `SNSClient`（`fromIni({ profile, filepath: awsCredentialsFile })`）で `Publish`。失敗しても例外を上げない。`reason` はエラーの種類だけ（`classifyAwsError` を使う）。

- [ ] **Step 1: `pnpm add @aws-sdk/client-sns@^3.1141.0`（`backend/control-plane` で。`minimumReleaseAge` で弾かれたら、ロックにある `@aws-sdk/*` と同じ版を指定する）。**
- [ ] **Step 2: `notify.ts` を書き、`service.ts` の確認の最後で `planNotifications` → `sendNotifications` → 成功したときだけ `ledger` を `next` にして保存（失敗なら `notifyError` に種類を入れ、`ledger` は進めない＝次の確認で送り直す）。**
- [ ] **Step 3: 確かめる** `pnpm typecheck` が 0。
- [ ] **Step 4: 差分をユーザーに見せる。**

テストを足すなら: `tests/status/notify.test.ts` — 「入力: 前回 ok で今回 action なら 1 通」「入力: 前回も action なら 0 通」「入力: 08:59 JST はまとめを送らず 09:00 は送る」「入力: unknown が 59 分は 0 通・60 分で 1 通・その後は 0 通」「入力: 本文に prod.conf の値があれば伏せ字」。

---

### Task 8: 監視アプリの画面と API

**Files:**
- Create: `frontend/next-js/app/(console)/setup-status/page.tsx`
- Create: `frontend/next-js/app/api/setup-status/route.ts`（GET・POST）
- Create: `frontend/next-js/app/api/setup-status/doc/route.ts`（GET `?file=&heading=`）
- Create: `frontend/next-js/components/setup-status/SetupStatusView.tsx`・`StepList.tsx`・`StepDetail.tsx`・`DocSection.tsx`・`help.tsx`
- Modify: `frontend/next-js/components/layout/routes.ts`（`HelpId` に `"setup-status"`、`NAVIGATION_ITEMS` の先頭に「設定の状況」、`resolveRoute` に `setup-status`）・Tools の切り替え（既存の help の登録の場所）
- Modify: `frontend/next-js/package.json`（`react-markdown`・`remark-gfm`）
- Modify: `frontend/next-js/README.md`（画面の表・構成）

**Interfaces:**
- Consumes: Task 4 の契約（`getSetupStatus`・`refreshSetupStatus`・`readSetupDoc`）、既存の `withControlPlane`・`requirePageSession`・`AutoRefresh`・`ConfigErrorView`。
- Produces: 画面 `/setup-status?step=<ID>`。API: `GET /api/setup-status` → `SetupStatusView`、`POST /api/setup-status` → `{ accepted }`（`Origin` の確認は既存の `guardApiRequest` に任せる）、`GET /api/setup-status/doc?file=&heading=` → `SetupDocSection` か 404。

- [ ] **Step 1: `react-markdown`・`remark-gfm` を足す（`minimumReleaseAge` を通る版）。**
- [ ] **Step 2: API の 2 本を書く。**
- [ ] **Step 3: 画面を書く。** 形は spec の 4 節（B）: 上に `Header`（最後の確認・次の予定・件数・「今すぐ確かめる」ボタン。`running` の間は無効）と `notifyError`・`reason` の `Alert`、左に `StepList`（段階ごとの `StatusIndicator`。● = `error`、! = `warning`、? = `stopped`〈文言「確かめられない」〉、◇ = `info`〈文言「人が確かめる」〉、✓ = `success`）、右に `StepDetail`（項目ごとに `ExpandableSection`。見出しの横に状態・だれが・止まる id、本文に根拠、開くと `DocSection` が API から節を読み `react-markdown` で描画。Markdown の中のリンクは新しいタブで開かず、相対パスはテキストとして出す）。選んだ段階は `?step=` に持つ（`router.replace`）。確認中は既存の `AutoRefresh` で読み直す。`enabled: false` なら `reason` だけを出す。
- [ ] **Step 4: `routes.ts` と Tools の help を足す。**
- [ ] **Step 5: 確かめる**
  Run: `cd frontend/next-js && pnpm lint && pnpm typecheck`（control-plane の `dist` の型が要るので、ユーザーの許可を得て control-plane の `pnpm build` を済ませてから）
  Expected: エラー 0。
- [ ] **Step 6: 確かめる（開発の監視アプリで画面を見る）** 開発の `.env` は `CONTROL_SETUP_STATUS_ENABLED` が無い（無効）ので、まず無効の表示（「本番の監視アプリだけで動く」）を `pnpm dev` の画面で確かめる。有効の表示は Task 10 で本番の値が入った後に確かめる。
- [ ] **Step 7: README を更新し、差分をユーザーに見せる。**

---

### Task 9: AWS の読み取り専用の主体（管理ポリシー）

**Files:**
- Modify: `cloud/stacks/iam.yaml`（`StatusReaderPolicy` と出力 `StatusReaderPolicyArn`）
- Modify: `cloud/template.yaml`（出力の受け渡し）
- Modify: `cloud/README.md`（4.5 の表に 1 行、4.5.2 の並びに「4.5.3 設定の状況の主体」）

**Interfaces:**
- Consumes: Task 2 の後の `check()` が `aws` で呼ぶ API の一覧。
- Produces: 管理ポリシー `comegin-${EnvName}-status-reader`（`Description` は作成後に変えると更新が失敗するので、最初から確定した文言で書く。iam.yaml の既存のコメントのとおり）。出力 `StatusReaderPolicyArn`。

- [ ] **Step 1: 一覧を作る。** `rg -n 'awsJson\(ctx, \[' cloud/setup frontend/next-js/setup middleware/n8n/setup backend/*/setup` と `cloud/setup/aws.mjs` の関数から、check の経路で呼ぶ `aws <service> <command>` をすべて書き出し、IAM のアクション名に直す（例 `cloudformation describe-stacks` → `cloudformation:DescribeStacks`）。apply だけで呼ぶもの（書き込み）は入れない。
- [ ] **Step 2: ポリシーを書く。** リソースを絞れるものはスタック・リポジトリ・トピック・ユーザーの ARN に絞る（`comegin-*` の名前の範囲）。絞れないものは iam.yaml の既存の例外と同じ形でコメントに理由を書く。**加えて** `sns:Publish` を `!Ref OpsAlertTopicArn` だけに。与えない: 書き込み全般・`secretsmanager:GetSecretValue`・`sns:Subscribe`/`Unsubscribe`/`SetTopicAttributes`・アラームの変更・S3 のオブジェクトの読み取り。
- [ ] **Step 3: 確かめる**
  Run: `cd cloud && sam validate --lint`（ビルドとデプロイはしない）
  Expected: エラー 0。
- [ ] **Step 4: `cloud/README.md` の 4.5・4.5.3（IAM ユーザー `comegin-prod-status-reader` を人が作り、このポリシーだけを付け、キーを `~/.config/comegin/status-reader/aws-credentials`〈600〉に直接書く。プロファイル名は `default`）を書く。差分をユーザーに見せる。デプロイはユーザーが行う。**

---

### Task 10: 本番の有効化（`next-js-prod`・`cloud` の段階 operate）と文書

**Files:**
- Modify: `frontend/next-js/setup/prod/index.mjs`（`.env` に Task 4 の変数を書く・止まる id `next-js-prod:status-principal`・`next-js-prod:status-github`）
- Modify: `cloud/setup/index.mjs`（段階 operate の「有効なキーが 1 つだけ」に `comegin-prod-status-reader`）
- Modify: `setup/00-setup-overview.md`（P14 に 2 行・4 節に「監視アプリが常に確かめる」の行と 5.3 のずれ）、`onprem/README.md`（「監視アプリ（改善ループ）を本番で動かす」に有効化と確かめ方）、`setup/manual-steps.md`（0 節の早見表に 2 つの id）、`setup/README.md`（`next-js-prod` の行）、`backend/control-plane/README.md`
- Modify: `setup/status/steps.mjs`（P14 の 2 行の追加に合わせる）

**Interfaces:**
- Consumes: Task 4 の環境変数、Task 9 のポリシー名。
- Produces: 止まる id `next-js-prod:status-principal`（`~/.config/comegin/status-reader/aws-credentials` のキーで `sts get-caller-identity` → `comegin-prod-status-reader` で、付いているポリシーが `comegin-prod-status-reader` だけ）・`next-js-prod:status-github`（`~/.config/comegin/status-reader/github-token`〈600〉で `GET /repos/<repo>` が 200 かつ `permissions.push` が false。トークンの値は表示しない）。`.env` に `CONTROL_SETUP_STATUS_ENABLED=true` ほか（`CONTROL_STATUS_ALERT_TOPIC_ARN` は本番スタックの出力 `OpsAlertTopicArn`。`CONTROL_STATUS_LINK_BASE` は `BETTER_AUTH_URL` と同じ値）。

- [ ] **Step 1: `next-js-prod` の apply と check に上の 2 つと `.env` の値を足す（`items` の `key` は `next-js-prod.status-principal`・`.status-github`、段階 P14）。**
- [ ] **Step 2: `cloud` の段階 operate の対象のユーザーに足す。**
- [ ] **Step 3: 文書を更新し、`steps.mjs` に P14 の 2 行を足す。**
- [ ] **Step 4: 確かめる**
  Run: `node setup/status/verify-steps.mjs` と `node setup/setup.mjs --target prod --phase operate --check`
  Expected: 前者は `0`。後者は（主体とトークンを作る前なら）`next-js-prod` が `… まだ` で、2 つの止まる id の説明が出る。
- [ ] **Step 5: 差分をユーザーに見せる。** 以後はユーザーの作業: PR → main → `sam deploy` → IAM ユーザーとキー → GitHub のトークン → `--phase operate` → `restart` → `http://127.0.0.1:3200/setup-status` で有効の表示を確かめる（Task 2 の Step 8 もここで一緒に行う）。

---

## Self-Review（書いた後の確認）

- spec の対応: 4 節→Task 8／5.1→Task 1・2・6／5.2→Task 3／5.3→Task 5（4 つ目の記事のずれは含めず、カタログで `none`＝◇）／5.4→Task 6／6・6.1→Task 6・9・10／6.2→Task 7／7→Task 4・10／8→各タスクの文書の Step／2 節の GitHub と作業ツリー→Task 5・Task 1・2。
- 型の名前: `StatusItem`（setup）と `SetupStatusItemView`（契約）は別物（前者はモジュールが返す、後者は画面に出す）。`SetupStatusLevel` の 5 値は `StatusItem.level` と同じ文字列。
