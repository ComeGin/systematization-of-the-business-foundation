# control-plane

監視アプリ（`frontend/next-js`）が取り込む管制ライブラリ。E-15（実行記録）・スケジューラ・Claude Agent SDK の起動・I-13 の起票・S3 への写し・ハートビート・誤った書き込みの突き合わせ・沈黙の検出を持つ。

設計の出典: `docs/RequirementDefinition/TA/07-onprem-control-plane.md`（3 節・6.2・9 節）、`docs/DetailedDesign/01`（3〜9 節）・`06`（1・2・5 節）・`07`（3・4・6・7 節）、`AA/05-application-decisions.md` の ADR-17・ADR-18。

境界の型は `src/contract.ts`（リードが所有。変更はリードに依頼する）。監視アプリは `createControlPlane()` と型だけを使い、環境変数を直接読まない。

## 使い方

```ts
import { createControlPlane } from "control-plane";

const plane = createControlPlane(); // 環境変数を zod で検証する。不正なら変数名と理由だけ stderr に出して ConfigError
await plane.start();                // CONTROL_SCHEDULER_ENABLED=false ならハートビートと写しの再送だけ
await plane.runNow({ target: { kind: "agent", agent: "seo-auditor", prompt: "..." } });
```

```bash
pnpm install
pnpm typecheck
pnpm build     # tsc → dist/（next-js は dist を読む）
```

Node 24 の `node:sqlite` を使う（`ExperimentalWarning` が出る）。ログは stderr だけ。行頭は `<ULID> <LEVEL> <連携点> <本文>`。

## 構成

```
src/index.ts          createControlPlane / loadControlPlaneConfig / ConfigError / ControlPlaneInputError
src/config.ts         zod。中核は必須、機能ごとのグループは「全部未設定 = 無効 / 一部だけ = 起動時に例外」
src/engine.ts         1 回の起動 = E-15 の 1 件。見送り判定 → 相関 ID の発行 → running を先に書く → 実行 → 確定
src/scheduler.ts      croner（Asia/Tokyo）。ジョブ定義は 1 時間ごとに再読み込み
src/runner/           agent.ts（SDK 起動）・hooks.ts（PreToolUse）・mcp.ts（登録表 → mcpServers）・output.ts
src/builtin/          i13-file・miswrite-check・silence-check・simple（heartbeat・runlog-flush）・lighthouse・a11y・published-article-check・article-cover・campaign-asset-upload・cycle（cycle-open・cycle-close）・cycle-collect
src/cycle/            改善ループの周の部品（calendar・service・proposals・previews・confirm・reflection・commands・git・cycle-doc・checklists・urls）。ADR-31
src/integrations/     http.ts（失敗分類 + 再試行）・github.ts・chatwoot.ts・aws.ts・runlog.ts・strapi.ts・mautic.ts・openai-image.ts
src/definitions/      schedules.ts・registry.ts・agent-def.ts・proposal.ts（E-13 の zod）
src/store/            SQLite（runs・leases・kv・miswrite_candidates・周と項目〈cycles.ts〉）。マイグレーションは PRAGMA user_version
src/constants/        failure.ts（9 値と判定順）・retry.ts・timeouts.ts・paths.ts・audit-sources.ts
```

`docs`・`ops` のパスはリポジトリ直下にある。断片は `src/constants/paths.ts` にまとめてあり、読み先は次のとおり。

| 読むもの | 読み先 | 理由 |
|---|---|---|
| エージェント定義 `.claude/agents/<name>.md`、`ops/schedules/*.yaml`、`ops/mcp-registry.yaml` | `CONTROL_MAIN_CHECKOUT` | 承認済み main だけが実行に効く（ADR-18） |
| 起票の対象 `docs/proposals/*.md`（draft）、`docs/audits/<source>/` | `CONTROL_WORKTREE` | 未コミットの成果物を読む |
| 突き合わせ (a) の承認済み提案 | `CONTROL_MAIN_CHECKOUT` | 作業ツリーの未承認の書き換えで「対応あり」にされないため |
| 監視アプリに出す観測（`listRunObservations`。`docs/audits/<source>/<audit_id>.md` の frontmatter だけ） | `CONTROL_WORKTREE` → `CONTROL_MAIN_CHECKOUT`（同じ `audit_id` は作業ツリーを優先） | エージェントが書いた未コミットの観測も、コミット済みの観測も出す |
| 監視アプリに出す Agent（`listAgents`・`getAgent`）と、その接続先の `access_level` | `CONTROL_MAIN_CHECKOUT` | 定義と同じく承認済み main だけ（ADR-18） |

### 監視アプリに説明を出すための読み込み（2026-11-06。設計は `docs/superpowers/specs/2026-11-06-job-agent-info-design.md`）

- `listJobs()` の定義に `prompt`（kind=agent のときの指示）と、`ops/schedules/*.yaml` の任意の欄 `overview`・`stage`・`io` を含める（書かれていなければ null）
- `listRunObservations(runIds)`: 実行ごとに、**書いた観測**（`fetch.correlation_id` が `runId` と一致）と**対象にした観測**（`targetIds` にあって書いた観測でないもの）を返す。`targetIds` はエージェントが自分で書く値で当てにならない（2026-11-06 の `daily-observe-ops` は観測を書いたのに `[]`）ので、「書いた」は `correlation_id` で決める。観測の ID の形（`AUD-YYYY-MMDD-<source>-NNNN`）に合わない値はファイルを開かない。キャッシュは持たず、呼ぶたびに読むが、読むのは実行の開始日（JST）とその翌日・`targetIds` の観測の日付のファイルだけ（`src/definitions/audits.ts` の `auditDatesForRuns`）。`fetch.note` はメールアドレスと電話番号の形を伏せ字にしてから返す（`pii.ts` の `redactPii`）。frontmatter が壊れた観測・読めない（`EACCES` など）観測は `outcome: null` として返し、画面ごと落とさない
- `listAgents()`・`getAgent(name)`: 定義と、それを使うジョブの id、ツールを接続先ごとにまとめたもの。ツールの「参照／書き込み」は**表示のための目安**で、権限の判定には使わない（`src/definitions/agent-catalog.ts` の `classifyTool`。登録表で `read_only` の接続先はすべて参照、それ以外は製品名の接頭辞を外した名前の先頭の動詞で分ける）。登録表が壊れていても画面は出す（`access_level` を出さないだけ）

## 環境変数（`.env.example` が正本）

| グループ | 変数 | 未設定のとき |
|---|---|---|
| 中核（必須） | `CONTROL_DATA_DIR`（既定 `~/.local/share/comegin-control`）・`CONTROL_MAIN_CHECKOUT`・`CONTROL_WORKTREE`・`CONTROL_SCHEDULER_ENABLED`（既定 `false`）・`CONTROL_AGENT_HOME`（任意） | 起動時に例外 |
| 改善ループの周 | `CONTROL_CYCLE_ANCHOR`（任意。JST の月曜の日付 `YYYY-MM-DD`。周は 14 日で ID は `C-<起点の日付>`） | 未設定なら、定義に `cycle_days` があるジョブは定期実行で `skipped`（理由に変数名だけ。手動の起動は見ない）。`cycle-open`・`cycle-collect`・`cycle-close` も `skipped`。形が違う・月曜でないときは起動時に例外 |
| 作業場の合わせ | `CONTROL_WORKTREE_SYNC`（任意。既定 `true`） | `cycle-open` が周の始まりに作業場を origin/main に合わせる。変更がエージェントの書く場所（`docs/audits/`・`docs/proposals/`・`docs/cycles/`）の未追跡のファイルだけなら、`fetch origin` の後、origin/main に同じパスがある未追跡のファイルを消して `checkout --detach origin/main`。`docs/proposals/PRP-*.md`（E-13 の写し）は中身が違っても消す（i13-file は `diff_ref: null` の本文を PR にコミットし、作業場の写しにだけ `PR #n` を書き戻すため、マージ後も中身が必ず違う。main の版が正本）。それ以外（`docs/audits/`・`docs/cycles/`）は同じ中身（`git hash-object` と `git rev-parse origin/main:<path>` が一致）のときだけ消し、違うものが 1 つでもあれば合わせない（件数だけを要約に出す）。origin/main に無いパスは残す。追跡済みの変更・それ以外の場所の変更があれば合わせない（人のコミット待ち）。git はシェルを通さず、env は `PATH`・`HOME`・`GIT_TERMINAL_PROMPT=0` だけ、`-c core.hooksPath=/dev/null` 付き、停止要求で止める（`src/cycle/git.ts`）。`false` なら合わせない |
| エージェント | `ANTHROPIC_API_KEY` | エージェントの起動は `skipped`（理由に変数名だけ） |
| 公開サイトの URL | `SITE_URL`（`campaign-planner`・`published-article-check` では**必須**。`lighthouse`・`a11y` も、無いと `astro build` が意図して停止する） | 設定されていれば、main のチェックアウトで動かす `pnpm lh` の子プロセスに渡し、**エージェントのプロンプトの末尾に `SITE_URL: <URL>` の行を足す**（末尾の `/` は除く。メールのリンクと `plugin.json` の `homepage` に使う）。`campaign-planner` は、この行が無いと何も作らずに止まる（URL を推測しない）。`published-article-check` は `SITE_URL` が無ければ `skipped`。`cycle-collect` は、メールのリンク先の組み立てと配信後の確認が `SITE_URL` を使い、無ければその項目だけを理由つきで飛ばす |
| I-13 | `GITHUB_TOKEN`・`GITHUB_REPOSITORY`・`I13_ISSUE_NUMBER`・`I13_REVIEWER`（`GITHUB_BASE_BRANCH` は既定 `main`） | 全部空なら `i13-file` は `skipped`。一部だけなら起動時に例外 |
| AWS | `AWS_REGION`・`RUNLOG_BUCKET`（`AWS_PROFILE`・`HEARTBEAT_NAMESPACE` は任意） | 全部空なら写しとハートビートは無効 |
| 突き合わせ | `MISWRITE_CHATWOOT_BASE_URL`・`..._ACCOUNT_ID`・`..._API_TOKEN`・`MISWRITE_AGENT_USER_ID` | 全部空なら `miswrite-check` は `skipped` |
| n8n の書き出し | `CONTROL_N8N_EXPORT_URL`・`CONTROL_N8N_EXPORT_API_KEY`（＋ I-13 の GitHub の 4 変数） | どれかが未設定なら `n8n-export` は `skipped`（片方だけの設定でも例外にしない。理由に変数名だけ） |
| Strapi | `CONTROL_STRAPI_URL`・`CONTROL_STRAPI_READ_TOKEN`（グループ。`CONTROL_STRAPI_WRITE_TOKEN` は任意で、アイキャッチの設定・配布ファイルのアップロードだけに使う） | 2 つとも空なら `published-article-check` は `skipped`（`SITE_URL` も要る）。片方だけなら起動時に例外。書き込みトークンだけの設定も例外。トークンはエージェントに渡らない |
| アイキャッチ画像 | `OPENAI_API_KEY`（グループではなく単独）・`CONTROL_OPENAI_IMAGE_MODEL`（任意。既定 `gpt-image-2.5-sunburst`。**画面〈監視アプリの「実行モデル」〉で選んでいないときの初期値**。下の「実行モデルの選択」）・`CONTROL_OPENAI_IMAGE_SIZE`（任意。既定 `1536x1024`。`幅x高さ`）・`CONTROL_COVER_MAX_PER_RUN`（任意。既定 3。1〜10）。既定は 2026-11-09 に OpenAI の公式ドキュメントで確認 | `OPENAI_API_KEY` が空・Strapi の URL と読み取りトークンが無い・`CONTROL_STRAPI_WRITE_TOKEN` が無い・`ops/prompts/article-cover.md` が main のチェックアウトに無いときは `article-cover` は `skipped`（生成の費用を出す前に見送る）。サイズの形が違う・枚数が 1〜10 でないときは起動時に例外。キーはエージェントに渡らない。書き込みトークンに記事の更新の権限が無い（403）ときは、アップロードまでにして `cover-pending:<documentId>:<fileId>` を `targetIds` に残す。画質は `medium` に固定（1 枚あたりの費用の上限）。生成・アップロードの失敗が記事ごとに連続 3 回に達した記事は対象から外す（summary に件数を出す。戻すには E-15 の kv のキー `article-cover:failures:<documentId>` を消す）。アップロードが認証・権限で失敗したら、その実行の以降の生成を打ち切って `failure` にする |
| 配信 | `CONTROL_DEPLOY_BUCKET`・`CONTROL_DEPLOY_DISTRIBUTION_ID`・`CONTROL_DEPLOY_AWS_PROFILE`（グループ） | 全部空なら deploy の項目に配信のコマンドを出さない。一部だけなら起動時に例外。control-plane は配信を実行せず、`cloud/README.md` の 4.14 と同じ 4 本のコマンド（`src/cycle/commands.ts`）を出すだけ。配る dist は main のチェックアウトの `dist/` ではなく、ビルドの成功後に `<CONTROL_DATA_DIR>/deploy/<sha 12 桁>-<記事の一覧のハッシュ 12 桁>/dist` へ写したもの（配信の対象になりうる deploy の項目の写しは残し、それ以外は合わせて新しい順に 3 件まで）。main のチェックアウトで build する builtin（lighthouse・a11y・published-article-check）は、リース `checkout-build` で同時に動かさない |
| Mautic の読み取り | `CONTROL_MAUTIC_URL`・`CONTROL_MAUTIC_CLIENT_ID`・`CONTROL_MAUTIC_CLIENT_SECRET`（グループ。参照専用ロールの API 認証情報。OAuth2 client_credentials） | 全部空なら `cycle-collect` は campaign の項目の中身を埋めず、確かめもしない（項目ごとに理由を出し、ジョブは止めない）。一部だけなら起動時に例外。トークンはプロセス内でキャッシュし期限の 60 秒前に取り直す。401 なら 1 回だけ取り直して再試行。セグメントの件数は統計の表 `lead_lists_leads` の件数だけを読む（個々のコンタクトは読まない）。認証情報はエージェントに渡らない |
| 設定の状況 | `CONTROL_SETUP_STATUS_ENABLED`（既定 `false`）。`true` のときだけ、`CONTROL_STATUS_AWS_CREDENTIALS_FILE`（絶対パス）・`CONTROL_STATUS_GITHUB_TOKEN_FILE`（絶対パス）・`CONTROL_STATUS_ALERT_TOPIC_ARN`（`arn:aws:sns:` で始まる）と、既存の `AWS_REGION`・`SITE_URL` が必須。`CONTROL_STATUS_AWS_PROFILE`（既定 `default`）・`CONTROL_STATUS_LINK_BASE`（既定 `http://127.0.0.1:3200`）・`GITHUB_REPOSITORY`（無ければ `ComeGin/systematization-of-the-business-foundation`）は任意 | `false`（本番の監視アプリだけで有効にする）なら `getSetupStatus()` は `enabled=false`。`true` で必須が欠けている・形が違う（`true`/`false` 以外・相対パス・`arn:aws:sns:` で始まらない・URL でない）ときは**例外にしない**（他の機能は動かす。spec 7）。`status` を `null`、`statusConfigError` に変数名と理由だけ（値は入れない）を入れ、`getSetupStatus()` は `enabled=false` でその理由を `reason` に出す（ログにも WARN で出す）。`AWS_REGION` を使うため、既存の AWS グループの規則で `RUNLOG_BUCKET` も必須になる |

秘密値（`GITHUB_TOKEN`・AWS・`MISWRITE_*`・`CONTROL_N8N_EXPORT_API_KEY`・`CONTROL_STRAPI_READ_TOKEN`・`CONTROL_STRAPI_WRITE_TOKEN`・`OPENAI_API_KEY`・`CONTROL_MAUTIC_CLIENT_SECRET`・`BETTER_AUTH_SECRET`）はエージェントの子プロセスに渡らない。設定の状況の資格情報・トークンは「ファイルの場所」だけを env に置き、値は確認のたびにそのファイルから読む。本番では `next-js-prod`（設定スクリプトの段階 `operate`）が、読み取り専用の主体（IAM ユーザー `comegin-prod-status-reader`。`~/.config/comegin/status-reader/aws-credentials`）と参照専用の GitHub のトークン（`~/.config/comegin/status-reader/github-token`。fine-grained PAT で、Contents と Pull requests を Read-only にするのは人。スクリプトは読めることと classic でないことまで確かめる）を確かめた後で、チェックアウトの `.env` に `CONTROL_SETUP_STATUS_ENABLED=true` と上の変数を書く（`CONTROL_STATUS_ALERT_TOPIC_ARN` はスタックの出力 `OpsAlertTopicArn`、`CONTROL_STATUS_LINK_BASE` は `BETTER_AUTH_URL` と同じ値）。有効にする手順は `onprem/README.md` の「設定の状況を有効にする」、主体は `cloud/README.md` の 4.5.3。

### 設定の状況の読み出し（`src/status`）

- `catalog.ts`: `loadCatalog(mainCheckout)` が `setup/status/steps.mjs`（手順の一覧の正本）を承認済み main のチェックアウトから `import()` して zod で検証する。`CATALOG_VERSION` が 1 でなければ `CatalogError`（値は出さない）。更新時刻を `?mtime=` に付けて、main が進んだときに古い版を掴まない。
- `docs.ts`: `readDocSection(mainCheckout, file, heading, allowedFiles)` が手順書の 1 節を返す。`file` はカタログの `docs` に現れるもの（`catalogDocFiles()`）だけ許し、`..`・絶対パス・チェックアウトの外を指すリンクは `null`。見出しの一致は `setup/status/verify-steps.mjs` と同じ（先頭一致。末尾が数字なら `4.1` は `4.10`・`4.1.1` に当たらない。コードブロックの中は見出しでない）。先頭一致が 2 つ以上あれば `null`。
- `drift.ts`: 設定スクリプトが確かめていないずれ（カタログの `probe: drift("<id>")`）。どれも読み取りだけで、根拠にトークンを入れない。
  - `site-redeploy`: 配信中の `build-info.json` の `commit` から `origin/main` までに `frontend/verdant-virgo` の変更があれば ●。毎回確かめる。
  - `n8n-workflows`: `origin/main` の本番に取り込むワークフローの JSON と本番の n8n を比べる。製品の API なので 1 時間に 1 回（間の回は前回の結果を引き継ぐ）。キー（`CONTROL_N8N_EXPORT_*`）が無ければ ◇。
  - `site-articles`（2026-11-11）: 本番の Strapi の公開済みの記事（`CONTROL_STRAPI_URL`・`CONTROL_STRAPI_READ_TOKEN`。書き込みのトークンは使わない）と、配信中の `build-info.json` の `articles` を slug で比べる。足りない（公開）・`updatedAt` が違う（更新）・余っている（取り下げ）を数え、**48 時間の猶予**（`ARTICLE_GRACE_MS`。ちょうど 48 時間は過ぎたもの）を過ぎたものがあれば ●。猶予中だけなら ✓ で根拠に「配信待ち N 件（猶予中。最も古いものの期限 <JST>）」。公開・更新は Strapi の `publishedAt`・`updatedAt` の新しいほうから、取り下げは最初に見つけた時刻（保存のずれの結果の `firstSeen` に slug ごとに残し、次の回に引き継ぐ）から数える。`articles` のキーが無い（この機能より前のビルド）・`build-info.json` が 404 なら ●、`articles: null`・Strapi に届かないなら ?、Strapi の読み取りの設定が無ければ ◇。根拠の slug は 5 件まで（超えたら「ほか N 件」）。製品の API なので `n8n-workflows` と同じく 1 時間に 1 回。

## 実行モデルの選択（2026-11-12）

監視アプリの「実行モデル」（`/models`）で選ぶ。選んだ値は E-15 の SQLite の `model_settings`（scope ごとに 1 行）に、変更は `model_setting_changes`（誰が・いつ・何から何へ）に残る。選ぶとすぐ次の実行から効く（起動し直しは要らない。実行中のものは変わらない）。

| 対象 | 決まり方（先にあるものが勝つ） |
|---|---|
| エージェント（Anthropic。`src/runner/agent.ts`） | Agent ごとの選択（`anthropic:agent:<名前>`）→ 全体の既定（`anthropic:default`）→ 定義の `model`（承認済み main の `.claude/agents`）→ Agent SDK の既定 |
| アイキャッチ画像（OpenAI。builtin `article-cover`） | 画面の選択（`openai:image`）→ `CONTROL_OPENAI_IMAGE_MODEL` → 既定 `gpt-image-2.5-sunburst` |

- **画面の選択は、承認済み main の定義より優先する**（ユーザーの決定。ADR-18 の例外。変更の履歴で追えるようにする）。
- 選べるのは、各社の API の一覧にあるものだけ（`src/models/available.ts`。Anthropic の Models API `GET /v1/models`、OpenAI の `models.list` のうち `gpt-image`・`chatgpt-image`・`dall-e` で始まるもの）。Anthropic は SDK のエイリアス（`opus`・`sonnet`・`haiku`）も選べる。一覧はプロセス内で 10 分覚える。**一覧を読めないときは変えさせない**（打ち間違いのモデル名で、夜の定期実行がすべて失敗するのを防ぐ）。
- 実際に使ったモデルは E-15 の `model`（S3 の写しにも入る）。エージェントは SDK の `init` が返したモデル（エイリアスを解決した id）、`article-cover` は生成を試した回の画像のモデル。

## E-15（実行記録）

- 置き場は `CONTROL_DATA_DIR/e15.sqlite`（作業ツリーの外）。書くのはこのライブラリだけで、エージェントには書かせない。
- 1 回の起動 = 1 件。相関 ID（ULID）は起動の直前に発行し、`running` の行を先に書いてからエージェントに渡す（プロンプトの `CORRELATION_ID: <ULID>` 行）。
- 残すのは要約・対象の ID・成否・起動の種類・費用だけ。ツールの結果は残さない。要約はメールアドレスと電話番号の形を `[redacted:...]` に伏せ、伏せたら `summaryRedacted=true`（氏名は形で検出できないため、エージェント定義の「人は ID で指す」規則に頼る）。
- 実行中の印は `leases` テーブル（リース時間 = `timeout_sec` + 60 秒。持ち主のプロセスが死んでいれば奪える）。前回が実行中なら起動を見送って `skipped` を記録する。起動時に、持ち主のいない `running` を `failure` に確定する。
- E-15 への書き込みが DB の例外（`database is locked` など）で失敗したとき: `running` の記録に失敗したら、取ったリースを返して起動を失敗にする（実行はしない）。結果の確定に失敗したら、stderr に `ERROR` を出してリースを返し、プロセスは落とさない（監視アプリと 1 プロセスのため）。その run は **次にプロセスを起動するまで `running` のまま残り**、起動時に `failure`（`timeout`）に確定する。
- 停止要求（`stop()`。`start()` の前に `runNow` で起動したものを含む）で打ち切った run は `failure`（`timeout`）に確定する。打ち切りの後に builtin が `success`・`partial` を返しても成功として残さない。
- **ハートビートは E-15 に記録しない**。5 分ごとで 1 日 288 件になり、エージェントの実行記録（見送り・失敗を見つけるための記録）が埋もれるため。止まったことは CloudWatch のアラームで知る。定義の `heartbeat` で起動した場合だけ記録される。
- `trigger` の `proposal` は、今は使っていない（定期実行は `schedule`、画面からは `manual`）。

## S3 への写し

`runs/YYYY/MM/DD/<ULID>.json`（日付は `startedAt` の日本時間）を、**単発の `PutObject`** に毎回 `IfNoneMatch: "*"` を付けて書く（バケットのポリシーが、`If-None-Match` の無い PutObject とマルチパートなどの作成系を拒否するため、`@aws-sdk/lib-storage` の `Upload` は使わない）。412 は「写し済み」として印だけ付ける。403 は `permission_denied`（ポリシーの拒否か資格情報の誤り）としてその回の送信を止める。1 件のスナップショットが 1 MiB を超えたら写さず、`invalid_response` の失敗として扱う（要約と ID だけなので通常は起きない）。未送は E-15 の `copied_at IS NULL` の行で、起動時・10 分ごと・各実行の終了時に古い順に再送する。写す内容は終了時に固めた `snapshot_json` で、再送でも変わらない。写しは正本ではない。

## builtin

| `builtin` | 内容 |
|---|---|
| `i13-file` | `docs/proposals/*.md` のうち `approval.state: draft` で `change.diff_ref` が null のものを、GitHub REST API でブランチ作成・コミット・PR 作成（Reviewer に `I13_REVIEWER`）し、`diff_ref` に `PR #n` を書き戻す。冪等キーは `proposal_id`（base に同名ファイルがあれば起票しない。途中で止まった続きのため、同じブランチの PR があれば再利用する）。30 秒、401 は再試行しない。ブランチは `<I13_ISSUE_NUMBER>-feature-proposal-<proposal_id>` |
| `runlog-flush` | S3 への写し（上記） |
| `heartbeat` | CloudWatch `PutMetricData`（`HEARTBEAT_NAMESPACE`、`Heartbeat=1`）。通常は内部の 5 分タイマーが送る |
| `miswrite-check` | 下記 |
| `silence-check` | 下記 |
| `lighthouse` | **`CONTROL_MAIN_CHECKOUT`** の `frontend/verdant-virgo` で `pnpm lh` を子プロセスとして実行し、結果の JSON を作業ツリーへ写す。詳細は下の「lighthouse の実行」 |
| `n8n-export` | 本番の n8n のワークフローを Git に書き出す。下の「n8n-export」 |
| `published-article-check` | **（2026-11-09 に実装。ADR-31）** 本番の Strapi の Content API を `CONTROL_STRAPI_READ_TOKEN` で読み、公開済みの記事の一覧（`documentId`・`publishedAt`・`updatedAt`）を**最後に確かめた配信のスナップショット**（kv の `published-article-check:snapshot`）と比べ、最後に確かめた配信のコミット（kv の `published-article-check:deployed-sha`）から `frontend/verdant-virgo` が変わったか（`git diff --name-only <deployed-sha> HEAD -- frontend/verdant-virgo`）を見る（Ruling 31）。新規・更新・消えた（非公開化・削除）記事か、公開サイトのコードの変更があれば、`main` のチェックアウトで `SITE_URL`・本番の Strapi の値・`BUILD_COMMIT_SHA`・`BUILD_TARGET=production` を渡して `pnpm lh`（ビルドと Lighthouse）を行い、`deploy` の項目を作る（`LH-seo` が 1.0 未満なら「配信できない」）。changes は最後に確かめた配信からの差分なので、配信を待つ間に main が進んだり別の記事が公開されたりしても、前の項目の記事が落ちない。項目のスナップショットは kv の `published-article-check:item-snapshot:<sourceRef>` に残し、**deploy の項目の確認が通ったときに、確認の処理が deployed-sha とスナップショットをその項目のものにする**。新しい項目を作ったら、承認前（`preparing`・`awaiting_review`）の古い deploy の項目を「新しい配信 <sha7> に置き換えた」で差し戻す（差し戻しの記録の actor は `system`。`docs/cycles` の差し戻しの節には載せない。人が差し戻した項目・置き換えた項目の項目のスナップショットは kv から消す）。OK 済み・実行済み・確かめられなかった（`approved`・`executed`・`failed_check`）古い deploy の項目があるあいだは、新しい項目を作らずに `skipped`（人が実行中の配信を追い越さない。`failed_check` は人が差し戻すまで残るので、項目の手順と `skipped` の理由に次の 2 文を出す。「同じ差分を配信し直すなら、差し戻さずに（failed_check のまま）この項目で「実行した」を押し直す。」「差し戻した場合は、新しい記事の公開か公開サイト（frontend/verdant-virgo）の変更があったときだけ、次の夜に新しい配信の項目が作られる（変更が無いあいだは作られない）。」）。画面の OK も、最新でない deploy の項目は拒む。同じ差分（`deploy:<frontend/verdant-virgo を最後に変えたコミット>:<スナップショットのハッシュ>`。公開サイトに関係しないコミットで main が進んでも変わらない。`preview.commitSha` はビルドした HEAD）の項目が既にあれば、どの状態でもビルドしない（ただし置き換えられた・確かめ済みの項目と同じ差分に戻ったときは、末尾に `:<n>` を付けた別の項目にする）。**成功したら `dist` を `<CONTROL_DATA_DIR>/deploy/<コミットの先頭 12>-<スナップショットのハッシュ 12>/dist` に写し**（`_build.json` のコミットが対象と一致することを確かめる。配信の対象になりうる項目の写しは残し、それ以外は合わせて新しい順に 3 件まで）、項目の `distPath` をそこにする。**`CONTROL_STRAPI_URL`・`SITE_URL`・`CONTROL_CYCLE_ANCHOR` のどれかが無ければ `skipped`**。**`main` のチェックアウトでビルドする builtin（`lighthouse`・`a11y`・`published-article-check`）は、共通のリース `checkout-build` を取ってから子プロセスを起動する。取れなければ `skipped`（別のビルドが動いている）** |
| `article-cover` | 本番の Strapi の下書きの記事のうち `cover` が空のもの（公開版がまだ無い新しい記事と、公開版の `cover` も空の記事だけ。Strapi 5 では公開済みの記事にも下書きの版があるため。Ruling 33）に、古い順に最大 `CONTROL_COVER_MAX_PER_RUN` 件まで、OpenAI の Images API（`openai` パッケージ。画質は `medium` 固定）で画像を作り、メディアライブラリへアップロードして `cover` に結ぶ。プロンプトの雛形は main の `ops/prompts/article-cover.md`。公開版に `cover` があり下書きの `cover` だけが空の記事は、画像を作らず公開版の `cover` のファイルを下書きに結ぶ（費用なし・`CONTROL_COVER_MAX_PER_RUN` に数えない）。記事ごとの連続の失敗が 3 回に達したら対象から外す（戻すには kv の `article-cover:failures:<documentId>` を消す）。結べない（403）ときはアップロードまでにし、`cover-pending:<documentId>:<fileId>` を `targetIds` に残して次回は結ぶことだけを再試行する。**`OPENAI_API_KEY`・Strapi の URL と読み取り・書き込みのトークンのどれかが無ければ、生成の前に `skipped`**。`timeout_sec` は 1200（枚数を増やすなら人が上げる）。`src/builtin/article-cover.ts` |
| `campaign-asset-upload` | 作業場の `campaign-assets/<proposal_id>/`（`manifest.yaml` があり、kv の `campaign-asset-upload:done:<proposal_id>` が無いもの）を、`plugin/` は zip に・`summary.md` は PDF（Playwright の Chromium。JavaScript を無効にし外部への要求を遮断する。無ければ PDF だけ見送る）にして、本番の Strapi のメディアライブラリへ上げ、キャンペーンの記事の下書きに結ぶ。**上げる前にすべて検証する**: `plugin.json` を main の `ops/schemas/agent-plugins-1.0.0/plugin.schema.json` で検証し、`name` の制約・`skills/*/SKILL.md` の frontmatter・`LICENSE` を確かめ、公開してはいけない名前（環境変数の実体ファイル〈`.example` 等は除く〉・`.git`・`node_modules`・`secrets`・`samconfig.toml`）とシンボリックリンクを拒否する。違反があれば 1 つもアップロードしない。1 ファイル 20 MB まで。`src/builtin/campaign-asset-upload.ts` |
| `cycle-open` | 改善ループの周の 0 日目（定期実行のとき。手動の起動は日を問わない）に今日の周を開き、期間が終わったのに閉じていない周を数えて閉じる（反映 0 件なら `cycle-close` と同じ知らせ。`cycle-collect` も最初に同じことをする）。`CONTROL_WORKTREE_SYNC` が `true` なら作業場を origin/main に合わせる（上の「作業場の合わせ」。作業場が名前のあるブランチにいるときは合わせない）。`src/builtin/cycle.ts` |
| `cycle-collect` | 毎日、今の周に項目を集める: 作業場の draft・review の E-13 を `proposal`（PR の状態は GitHub）、承認済みで未適用の `config_change` を `manual`、作用のジョブ（`trigger: proposal`）の結果を `article`・`campaign`・`code` の中身に（失敗・見送り・成果物の無い `partial` で終わった実行の準備中の項目は `failed_check` にする。画面で差し戻せる。campaign はキャンペーンの `email.send` のイベントのメールが作ったメールと一致するときだけ OK 待ちにする）、キーワードの経路の下書きを `article`（`strapi:article:<documentId>`）に。`executed` の項目を確かめ（`src/cycle/confirm.ts`）、確かめ済みの `article`・`code` が確かめ済みの `deploy` に含まれたら反映を記録する（`src/cycle/reflection.ts`。code は PR のマージのコミットが配信のコミットの祖先か同じかを GitHub の比較で確かめる）。awaiting_review より先の項目の中身は書き換えない。作業場の `docs/cycles/<周 ID>.md` に、この周に作られた項目と、周を問わずこの周の期間に差し戻された・確かめられなかった項目の理由の要約を書き出す。エージェントの結果は `CREATED: <種類>=<ID>` の行を `created:<種類>=<ID>`（files はファイルごとに `created:file=<パス>`）として `targetIds` に残したものから読む（`src/runner/output.ts`）。`src/builtin/cycle-collect.ts` |
| `cycle-close` | 月曜 00:05 に、今日の周を開く（冪等。`cycle-open`・`cycle-collect`・`published-article-check` のどれも動かなかった周の行を作る）。続けて、期間が終わった（今 >= 周の終わり）のに閉じていない周だけを（Ruling 32。手で起動しても期間の途中の周は閉じない。閉じる周が無ければ `skipped`）、確かめ済みの配信に含まれた `article`・`code` の反映を記録してから（記事は、その配信を作った時点の記事の一覧で書き直した版が公開済みのものだけ数える。公開・配信と下書きの更新時刻の比較には 5 秒の許容幅を入れる）、反映の件数（E-13 由来・キーワード由来。`manual` は除く）と止まっている場所を数えて周を閉じる。両方 0 件なら、`CONTROL_SETUP_STATUS_ENABLED` の SNS（`status/notify.ts`）で「[ComeGin 改善ループ] この周は反映できなかった」を送る。知らせの設定が無ければ要約に書いて `success` |

### n8n-export（本番の n8n のワークフローの書き出し）

TA-03 の 6 節の方針（n8n → Git の一方向。資格情報は ID の参照だけ）の実装。**作業ツリーには何も書かない**（読むのは `CONTROL_MAIN_CHECKOUT` だけ。結果は GitHub の PR だけ）。

| 項目 | 内容 |
|---|---|
| 読み先 | 本番の n8n の Public API。`GET /api/v1/workflows?limit=250` を `nextCursor` で全ページ（20 ページまで。超えたら `truncated`）→ 1 件ずつ `GET /api/v1/workflows/{id}`。アーカイブ済みは対象外。ヘッダーは `X-N8N-API-KEY`。30 秒、401 は再試行しない |
| API キーのスコープ | 一覧が `workflow:list`、本体が `workflow:read`。**スコープを付けられるのは n8n の Enterprise だけで、コミュニティ版のキーは全権限になる。** キーは監視アプリの env にだけ置き、エージェントには渡らない（エージェントの env は `PATH`・`HOME`・`ANTHROPIC_API_KEY` の許可リスト）。有効化（`enabled: true`）の前に、本番の n8n の版を確かめて人が判断する。代案の CLI（`docker exec`）は監視アプリに docker の権限が要るので採らない |
| 除去 | トップ: `id`・`versionId`・`activeVersionId`・`activeVersion`・`createdAt`・`updatedAt`・`pinData`（空の `{}` に直す）・`staticData`・`shared`・`triggerCount`・`isArchived`・`versionCounter`・`sourceWorkflowId`・`parentFolder`・`meta.instanceId`。ノード: `createdAt`・`updatedAt`。`settings` の `binaryMode`・`credentialResolverId`（派生の内部の設定）。`tags` は名前の配列にする。ノードの `credentials` はそのまま（`{ 種別: { id, name } }`。値は API が返さない） |
| 残す | **`active` は本番の事実として残す**（本番で公開すれば `true` が Git に出る）。`name`・`nodes`・`connections`・`settings`・`description`・`nodeGroups` |
| 整形 | インデント 2・末尾に改行。トップとノードのキーは固定の順（既存の `workflows/*.json` に合わせた画面の書き出しの順。ほかは末尾にアルファベット順）、**それ以外のオブジェクトのキーは再帰的にアルファベット順**。配列の順序は変えない（`nodes`・`connections` の中の配列を含む）。既存のファイルは、内容は同じでキー順だけが変わるため、**初回の PR は 1 度だけ再整形の差分が出る**（資格情報の `id` も、既存のファイルは持たないため差分になる） |
| ファイル名 | 承認済み main の `middleware/n8n/workflows/*.json` の `name` と n8n のワークフロー名の完全一致（NFC）。無いものは名前から作る（`I-<数字>` で始まる名前はその番号を残し、残りを小文字の ASCII の kebab-case にする。空になれば `workflow-<id>`。衝突したら id を付ける） |
| 比較 | 整形した文字列を、main の同名ファイルと**バイト単位で**比較する。差分があるものは GitHub の base の内容とも比べ、同じなら除く（main のチェックアウトが origin より遅れていても、マージ済みの内容で二重に PR を作らない）。差分が無ければ `success` で何もしない |
| 消さない | **n8n に無い・名前が変わったワークフローの旧ファイルは消さない**（開発だけにあるものを消さないため）。本番で改名すると、新しい名前は**新規ファイル**として扱われ、旧ファイルが残る。人が旧ファイルを消す（仕様。`id` をファイルに残さない方針のため） |
| 秘密値の検査 | GitHub に出る前に、ノードの値を検査する: キーが `secret`・`token`・`password`・`api_key`・`authorization` を含み値が固定の文字列、ヘッダーなどの `{ name, value }` の対で name がそれらを含み value が固定、または既知のトークンの形（`ghp_`・`github_pat_`・`AKIA`・`xox*-`・`sk-`・`Bearer` ＋ 20 文字以上・秘密鍵のヘッダー）。式（`{{ }}`）・空・URL は除く。**疑いのあるワークフローは PR から外し**、E-15 の要約には「ワークフロー名: 秘密値の疑い」だけを書く（値・キーの中身は書かない）。結果は `partial`。誤検知は人が n8n 側で式や資格情報に直すまで外れ続ける |
| PR | ブランチ `chore/n8n-export-YYYYMMDD`（日本時間）。1 コミット（Git Data API の tree → commit → ref。ref を最後に作るので、ブランチがある = コミットが済んでいる）。Reviewer は `I13_REVIEWER`。冪等キーは日付: 同じブランチの PR があれば何もしない。**別の日の未マージの書き出しの PR（`chore/n8n-export-` の open）があれば、新しく作らない**（毎日 PR が積み上がらないように）。PR の本文はファイル名の一覧だけ（ワークフローの中身は載せない）。ローカルの Git の状態は変えない |

### lighthouse の実行

control-plane が子プロセスを起動するのはここ 1 か所だけ（`src/builtin/lighthouse.ts`）。作業ツリーの `package.json` の script や `lighthouserc.cjs`・`.npmrc` はエージェントが書けるため、そこで `pnpm lh` を実行すると control-plane の権限で任意のコードが動く。そのため次のとおりにしている。

| 項目 | 内容 |
|---|---|
| 実行元 | `CONTROL_MAIN_CHECKOUT`（承認済み main）。配信されるのも main なので、計測の対象としても正しい（記事の中身は本番の Strapi から読む） |
| 前提 | **人が main のチェックアウトで `pnpm install` を済ませておく。** `node_modules` が無ければ実行せず、`skipped`（理由: dependencies not installed）を記録する |
| `HOME` | 実ホームを渡さない。`CONTROL_AGENT_HOME`、無ければ使い捨ての一時ディレクトリ（実行後に削除） |
| env | `PATH`・`HOME`・`npm_config_ignore_scripts=true`（万一 pnpm が依存の解決に入ってもライフサイクルスクリプトを動かさない）・`SITE_URL`（`SITE_URL` を設定していれば）だけ |
| 結果の写し | main 側の `.lighthouse/` の、今回の実行で更新された `lhr-*.json` と `manifest.json` だけを、作業ツリー側の同じ場所に control-plane がコピーする（seo-auditor は作業ツリーの中しか読めない）。通常のファイルだけで、シンボリックリンクはたどらず、写し先がシンボリックリンクなら拒否する。25 MiB を超えるものは写さない |

### miswrite-check（照合の規則は仮置き）

TA-07 の 6.2・DD-07 の 4.1 は「どの E-13 にも対応しない」の定義を決めていない。次の規則を**仮置き**している。見直すときはここと `src/builtin/miswrite-check.ts` を直す。

エージェント専用ユーザー（`MISWRITE_AGENT_USER_ID`）が送信した（`message_type=1`）メッセージを、次のどちらにも当たらなければ候補にする。

- (a) `CONTROL_MAIN_CHECKOUT` の `docs/proposals/*.md` のうち `approval.state` が `approved` / `applied` で、`target.identifier` または `also_affects` に `display_id=<n>` を含み、送信時刻が `created_at` 以降のもの
- (b) 送信時刻が前後 1 分の幅で重なる E-15 の run の `targetIds` に `chatwoot-conversation:<n>` があるもの（`targetIds` はエージェントの `TARGET_IDS:` 行に加え、`mcp__chatwoot*` の `tool_use` の `conversation_id` から取り出す。結果は読まない）

範囲は「前回の完了から今まで」（初回は 24 時間前。5 分の重なりを持たせ、重複は `message_id` で除く）。本文は保存せず、ID・時刻・理由だけを残す。会話は更新の新しい順（上流の既定）に最大 40 ページ（25 件/ページ）、メッセージは 1 会話あたり最大 10 ページ（20 件/ページ。上流は 1 ページを古い順に返すので、最も小さい id を `before` にして遡る）を読み、上限に達したら `partial`（`truncated`）にして前回完了の時刻を進めない。**拾えるのは送信だけで、会話の属性（担当者・ラベル・状態）の変更は拾えない。**

### silence-check

`E-15` と成果物の照合だけを行う（エージェントに E-15 を読ませない。DD-07 の 3.2）。当日は日本時間の 0 時から今まで。

- 成果物なし: `success` のエージェントの run があるのに、そのエージェントの `docs/audits/<source>/` に当日分（`AUD-<西暦>-<月日>-<source>-*`）が 1 件も無い（対応は `src/constants/audit-sources.ts`）
- 未起動: `CONTROL_SCHEDULER_ENABLED=true` で、`enabled` のジョブの起動時刻（猶予 10 分）を過ぎているのに、その起動の窓に `skipped`・手動（`trigger=manual`）を含めて run が 1 件も無い。窓は起動時刻の 1 分前から次の起動時刻の 1 分前まで（1 分は間隔の半分を超えない）。1 日に複数回のジョブは起動時刻ごとに判定するので、後の起動の run が前の起動の欠落を隠さない

検出しないもの: 開発機・監視アプリ自身の停止（ハートビートの役目）、成果物の中身の正しさ。検出があれば `partial`、要約に件数とエージェント名・ジョブ ID だけを書く。

## 失敗分類・再試行・タイムアウト

- 9 値と判定順は `src/constants/failure.ts`（DD-01 の 4.2・4.4）。Chatwoot の 401 は `permission_denied` に倒す（5.3）。
- 再試行の表は `src/constants/retry.ts`（5.2〜5.4）。`fetchJson`（`src/integrations/http.ts`）が適用する。**エージェントの実行は再試行しない**（費用が発生する連携は回数 0 とする規則に合わせた。この層の判断）。
- `rate_limited` は総予算 30 秒を優先する（DD-01 の 5.2 にリードが追記）。待ち（`Retry-After`、無ければ 60 秒）が残りの予算に収まるときだけ 1 回再試行し、収まらなければ待たずに `rate_limited` の失敗として返して次の定期実行に任せる。上流の指定より短く待って送り直すことはしない。
- タイムアウトの表は `src/constants/timeouts.ts`（7.2）。DD-01 に無い S3・CloudWatch の値は `CONTROL_TIMEOUT_SEC` に別に持つ。

## Agent SDK の安全設定

SDK `@anthropic-ai/claude-agent-sdk` のオプション名と挙動は、公式ドキュメント（context7）と型定義（`sdk.d.ts`）で確認した。

| 設定 | 値 | 理由 |
|---|---|---|
| `settingSources` | `[]` | 作業ツリーの `.claude/settings.json` と CLAUDE.md に未承認の内容が混ざっても、実行に効かせない（ADR-18）。`~/.claude` のフックも読まれなくなるため、拒否は下の `hooks` で入れ直す |
| `permissionMode` | `dontAsk` | `allowedTools` に無いものを確認なしで拒否する。`bypassPermissions` は使わない。起動直後の `system/init` で `dontAsk` になっていなければ打ち切る |
| `tools` | 定義の `tools` のうち組み込みだけ | `allowedTools` は事前承認で、利用可能なツールの制限ではない（型のコメント）。制限は `tools` で行う |
| `allowedTools` / `disallowedTools` | 定義の `tools` / 定義の `disallowedTools` + `Bash`・`PowerShell` | エージェント定義の許可リストをそのまま使い、監視アプリの側で広げない。`Bash` を含む定義は起動しない（fail closed）。`init` のツール一覧に Bash 系があれば打ち切る |
| `env` | `{PATH, HOME, ANTHROPIC_API_KEY}` | `env` は子プロセスの環境を丸ごと置き換える（`process.env` とマージされない）。AWS・GitHub・Better Auth の秘密値は渡らない。`init` の `apiKeySource` が `ANTHROPIC_API_KEY` でなければ打ち切る（ユーザーの OAuth ログインで動くのを防ぐ） |
| `hooks.PreToolUse` | `src/runner/hooks.ts` | ファイルツールを `CONTROL_WORKTREE` の realpath の内側に閉じ込める。内側でも `.env`・`.env.*`（`.example`・`.sample`・`.template` を除く）・`samconfig.toml`・`secrets/`・`.git` を拒否。`CONTROL_DATA_DIR`・`CONTROL_MAIN_CHECKOUT`・`~/.aws`・`~/.config/comegin`・`CONTROL_AGENT_HOME` も拒否。`Glob`・`Grep` のパターンに `..` や外を指す絶対パスがあれば拒否。**限界:** `Grep` が作業ツリーの中を再帰的に読むときに秘匿ファイルを避けるのは、ripgrep が `.gitignore` を尊重することに頼る（直接のパス指定は必ず拒否する） |
| `hooks.PreToolUse`（エージェント固有。`inspectAgentSpecific`） | `src/runner/hooks.ts` | **`campaign-planner`**: Mautic の `mautic_create_record` は `emails`・`campaigns` だけで、`isPublished` を**明示的な false**にしない作成（省略を含む）は拒否する。`emails` は `emailType: "template"` で `lists` を持たない（省略か空の配列）ものだけ（`list` のメールは公開するとセグメントへ一斉に送れるため。I5）。`campaigns` の `events` は `email.send` だけ（Mautic に「待つ」という独立のイベント型は無い。待ちは `triggerMode` で表す）。更新・削除・`segments` の作成は拒否。Strapi は公開・非公開化・削除・下書きの破棄を拒否し、`create_article` の `publishedAt`・`status: "published"` も拒否する。ファイルの書き込みは `campaign-assets/` の下だけ。**`design-implementer`**: 書き込みは `frontend/verdant-virgo/src/` の下だけ。**どちらも `.claude/agents/` の `tools` の許可リストとの 2 重の守り**（ADR-32） |
| `hooks.PreToolUse`（書き込み系の追加） | `src/constants/write-denylist.ts` | `Write`・`Edit`・`MultiEdit`・`NotebookEdit` は、作業ツリーの中でも次を拒否する。**理由:** これらは人や control-plane が後で実行する、または実行の条件を決めるため、書けるとエージェント自身の権限を広げる経路になる。`package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`.npmrc` ほかパッケージの設定、`node_modules/` の下すべて、`*rc.js|cjs|mjs`・`*.config.{js,cjs,mjs,ts}`、`dev/` の下の `*.sh`、`Dockerfile`・`compose*.yml`、`.envrc`、`.git/`・`.github/`・`.husky/`・`.claude/`・`{ops,cloud}/`。エージェントが書くのは `docs/audits`・`docs/proposals` と、design-implementer の `frontend/verdant-virgo/src/`、campaign-planner の `campaign-assets/` の下だけ |
| `strictMcpConfig` | `true` | 渡した `mcpServers` だけを使い、`.mcp.json` やユーザー設定の MCP を無視する |
| `mcpServers` | そのエージェントの `tools` に出る登録だけ | `mcp__<name>__<tool>` の `<name>` を登録表から引く。登録表に無い名前は起動前に `failure` にする |
| `persistSession` | `false` | SDK 自身の会話履歴（MCP のツール結果を含む）が `~/.claude` に残ると、ADR-18 の「ツールの結果は残さない」に反する |
| `cwd` | `CONTROL_WORKTREE` | 成果物を書く場所 |
| `abortController` / `maxTurns` | `timeout_sec` / `max_turns` | 打ち切り。結果の `subtype`・`is_error`・`total_cost_usd` を E-15 に記録する |
| `systemPrompt` | `claude_code` のプリセットにエージェント定義の本文を追記 | 定義は main のチェックアウトから読む |

MCP の登録表の `env_vars`（stdio のみ・任意）: 子プロセスに渡す**秘密でない定数**（例 `TRANSPORT: stdio`。mautic-mcp は既定が http で、env ファイルに書き忘れるとポート 3100 の HTTP サーバーとして起動してしまうため）。キー名が `/secret|password|token|api_?key|hmac|key$/i` に合うものは、読み込みのときに拒否する。登録表の `env`（`dev` | `prod`）と名前が重なるため、キー名は `env_vars`。子プロセスの env は control-plane の `process.env` を混ぜず、`PATH` と実ホームの `HOME` に `env_vars` を足したものだけを渡す（SDK がこの env を既存の環境に足すか置き換えるかは未確認。どちらでも動くよう `PATH` と `HOME` を明示している）。

MCP の登録表（`ops/mcp-registry.yaml`）の扱い: stdio は `args` の相対パスを `CONTROL_MAIN_CHECKOUT` から解決し、`${HOME}` を**実ホーム**で展開する（`CONTROL_AGENT_HOME` を使っていても env ファイルのパスが変わらない）。`--env-file-if-exists` の値は MCP サーバの子プロセスが読む。http は `headers_from_env_file` の env ファイルを control-plane が読んでヘッダーを作る。エージェントは `~/.config/comegin` を読めない。

ユーザープロンプトの先頭には、control-plane が次の 3 行を自動で付ける（固定シート 10 節。エージェントには Bash が無く現在時刻を知る手段が乏しいため）。`NOW` と `TODAY` は E-15 の `startedAt` と同じ時刻から `promptHeader()`（`src/runner/agent.ts`）の 1 か所だけで作る。

```
CORRELATION_ID: <ULID>
NOW: <JST の ISO 8601（秒精度）。例 2026-10-04T06:00:00+09:00>
TODAY: <JST の YYYY-MM-DD>
```

エージェントの最終出力は `SUMMARY:` 行（個人情報を含まない 1 文。PII 検査を通して E-15 に入る）と、末尾の `TARGET_IDS:` 行（カンマ区切り。`[A-Za-z0-9:_-./=#]` だけの ID を残し、メールアドレスなどは落とす）。`SUMMARY:` が無ければ `partial`。`proposal-writer` が `success` で終わったのに `docs/proposals/` の E-13 が増えていなければ、`skipped`（理由は要約）として記録する（DD-06 の 1.2 の「止めた事実を残す」）。

結果の分類（`src/runner/agent.ts`）:

| 状況 | outcome | failureClass |
|---|---|---|
| タイムアウト・停止要求 | `failure` | `timeout` |
| `error_max_turns` | `partial` | `truncated` |
| `error_during_execution` ほかの error | `failure` | `invalid_response` |
| `success` だが `is_error`（`api_error_status` が 401 / 403 / 429 / 5xx） | `failure` | `auth_failed` / `permission_denied` / `rate_limited` / `unreachable` |
| 結果メッセージ無しで例外 | `failure` | `unreachable` |
| `init` で MCP の接続が `failed`、検査違反 | `failure` | `unreachable` / `auth_failed` / `invalid_response` |

### HOME の分離（`CONTROL_AGENT_HOME`）

設定すると、SDK の子プロセスに実ホームの代わりにそのディレクトリを `HOME` として渡す。`~/.aws`・`~/.config/comegin`・ユーザーの `~/.claude`（OAuth ログイン・メモリ・履歴）が子プロセスの `HOME` から見えなくなり、拒否フックだけに頼らずに済む。空なら実ホームを渡し、拒否フックだけで守る。

**未確認:** 実際に `ANTHROPIC_API_KEY` だけで CLI が動くかは、API を呼べないため確かめていない（Wave 4 の立ち会いで確認する）。動かない場合は `CONTROL_AGENT_HOME` を空にする。`init` の `apiKeySource` の検査があるため、API キーで認証されない状態で動き続けることはない。

## 未決定・TODO

- （2026-11-09 に解決。ADR-31）`published-article-check` の実装・非公開化と削除の検知・Strapi を読む資格情報の置き場（`CONTROL_STRAPI_READ_TOKEN`。エージェントに渡さない）。HEAD の変化は `frontend/verdant-virgo` の差分があるときだけコードの変更とする（最終レビューの Ruling 31）。残るのは、配信の確認項目にコードの変更の範囲を出すこと（M5。後回し）
- 突き合わせの照合規則の確定（上記は仮置き。`nearestRunId` は時刻の重なりだけで決めている）
- 止まっていた間の取り戻し（DD-07 の 3.4）。スケジューラは取り戻さない。定義側の基準日で行う設計で、範囲外
- `CONTROL_AGENT_HOME` の動作確認（Wave 4）
- 失敗・見送りを誰にどう知らせるか（DD-07 の 8 節。画面に出すだけでは沈黙と同じ）
- 定義の再読み込みは 1 時間ごと。`main` のチェックアウトを更新する主体とタイミングは未決定（TA-07 の 9 節）
- S3 の保持期間・削除の手段（TA-06 の担当）
