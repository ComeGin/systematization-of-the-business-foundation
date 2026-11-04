# ops/ — 定期実行の定義と MCP の登録表

監視アプリ（`frontend/next-js`。サーバー側は `backend/control-plane`）が、エージェントを**いつ・何を・どのツールで**動かすかを決める定義を置く。設計は [TA-07 の 3.5](../docs/RequirementDefinition/TA/07-onprem-control-plane.md)、[TA-03 の 2・3.3](../docs/RequirementDefinition/TA/03-triggers-and-cicd.md)、[AA-03 の 3・4](../docs/RequirementDefinition/AA/03-agent-architecture.md)、[DD-03 の 7](../docs/DetailedDesign/03-operation-path-flows.md) にある。

```
ops/
├── schedules/<job-id>.yaml   定期実行の定義 1 本 = 1 ファイル（ファイル名 = id）
└── mcp-registry.yaml         MCP サーバの登録表（秘密値は書かない）
```

エージェントの定義は、このディレクトリではなくリポジトリ直下の `.claude/agents/<name>.md`（12 本）にある。

## 守ること（ADR-18）

- **監視アプリは、承認済みの `main` から作った別のチェックアウト（`CONTROL_MAIN_CHECKOUT`）からだけ、ここと `.claude/agents/` を読む。** 作業ツリーで書き換えても、承認されて `main` に入るまで次の実行には効かない（エージェントが自分の実行条件を書き換えられないようにするため）
- **変更は必ず PR を通す。** 取得の範囲・頻度・使うエージェントとツールを変えるのは、承認ゲートの対象（`E-14` と同じ経路）である。エージェントは `ops/` と `.claude/` に書けない（control-plane が拒否する）
- **`enabled` は人が PR で `true` にする。** 初期値はすべて `false`
- **秘密値を書かない。** 登録表には env ファイルのパスと変数名だけを書く

## 定期実行の定義（`schedules/*.yaml`）

形式は固定シート 7 節（`backend/control-plane/src/definitions/schedules.ts` が検証する）。

| 項目 | 内容 |
|---|---|
| `id` | ファイル名と同じ。kebab-case |
| `cron` | 5 フィールド。Asia/Tokyo |
| `kind` | `agent`（`agent` と `prompt` が必須）／ `builtin`（`builtin` が必須） |
| `after` | 先に当日 `success` で終わっている必要がある job の id。満たさなければ見送って `skipped` を記録する |
| `prompt` | **取得の範囲（期間・件数・上限）をここに固定する。** エージェントに決めさせない（実行のたびに範囲が変わると `E-13` の `evidence` が比較できなくなる） |

前回の実行が終わっていなければ、起動を見送って `skipped` を理由つきで記録する。

### 一覧（初期値は `enabled: false`。2026-11-02 に `heartbeat` 以外を有効にした）

| id | 種類 | 実行 | 内容 |
|---|---|---|---|
| `daily-observe-seo` | agent | 毎日 04:00 | `seo-auditor`。GSC の実績（`source: gsc`） |
| `daily-observe-analytics` | agent | 毎日 04:00 | `analytics-reporter`。GA4（OpenSEO 経由）・Mautic（参照専用）・PostHog の集計 |
| `daily-observe-conversations` | agent | 毎日 04:00 | `conversation-triage`。未解決の会話の一次切り分け（社内メモのみ） |
| `daily-observe-ops` | agent | 毎日 04:00 | `ops-watcher`。直近 24 時間の例外 |
| `daily-propose` | agent | 毎日 04:30 | `proposal-writer`。**観測 4 本を `after` で待つ**。起票前チェック 15 項目を通したものだけ起票 |
| `monthly-analysis` | agent | 毎月 1 日 05:00 | `proposal-writer`。順位・流入・CVR の月次の判断 |
| `weekly-lighthouse` | builtin | 毎週月曜 00:30 | `pnpm lh`（`lighthouse`） |
| `weekly-observe-lighthouse` | agent | 毎週月曜 01:45 | `seo-auditor`。計測の完了を `after` で待ち、`source: lighthouse` に正規化 |
| `weekly-a11y` | builtin | 毎週月曜 01:15 | `pnpm a11y:ci`（`a11y`。`astro build` から axe の検査まで）。結果の `.a11y/*.json` を作業ツリーに写す。**`after` を持たない**（Lighthouse の揺れで止めない・古い `dist` を測らない）。`weekly-lighthouse`（01:00 までに終わる）とは時刻で重ねない。**UI を変える提案を自動で起票する前提**（下の注記） |
| `weekly-observe-a11y` | agent | 毎週月曜 02:00 | `quality-checker` の項目 6 だけ。検査の完了を `after` で待ち、`QC-a11y-*` を `source: quality` に正規化。**UI を変える提案を自動で起票する前提**（下の注記） |
| `weekly-observe-serp-audit` | agent | 毎週月曜 02:00 | `seo-auditor`。ランク追跡とサイト監査の保存済みの結果（`serp` `site_audit`） |
| `weekly-keyword-research` | agent | 毎週月曜 02:30 | `keyword-researcher`。**費用が発生する**（1 回 2,000 クレジットまで） |
| `weekly-content-draft` | agent | 毎週火曜 02:30 | `content-writer`。承認済みの企画から下書きを 1 本（公開は `R2`） |
| `weekly-content-plan` | agent | 毎週水曜 02:30 | `content-planner`。採用済みのキーワードから企画を起案 |
| `heartbeat` | builtin | 5 分ごと | ハートビート（CloudWatch）。途絶えたら改善ループが止まっている |
| `runlog-flush` | builtin | 0〜8 時の 15 分ごと（最後は 07:45） | `E-15` の写しを S3 に追記（送れていない分を送り直す） |
| `daily-i13-file` | builtin | 毎日 05:30 | `I-13`。`draft` の `E-13` から GitHub に PR を作る |
| `daily-miswrite-check` | builtin | 毎日 05:45 | 誤った書き込みの突き合わせ |
| `daily-silence-check` | builtin | 毎日 06:00 | 沈黙の検出 |
| `daily-n8n-export` | builtin | 毎日 06:15 | 本番の n8n のワークフローを Public API で読み、差分があれば GitHub に PR（`chore/n8n-export-YYYYMMDD`）。作業ツリーには書かない。**有効化の前に、API キーのスコープ（Enterprise のみ）を人が判断する**（`backend/control-plane/README.md` の n8n-export） |
| `published-article-check` | builtin | 毎日 00:00（暫定） | 公開された記事の確認。あればビルドと計測を起こす |

- **`weekly-a11y` を有効にする前に、人が `CONTROL_MAIN_CHECKOUT` の `frontend/verdant-virgo` で `pnpm install` と `pnpm exec playwright install chromium` を済ませておく**（Chromium は実ホームの `~/.cache/ms-playwright` に入り、builtin が `PLAYWRIGHT_BROWSERS_PATH` で渡す。無ければ `skipped`）。**a11y の 2 本（`weekly-a11y`・`weekly-observe-a11y`）を有効にすることが、UI を変える提案（`technical_seo`・`cta_swap`・`experiment_start`）を自動で起票する前提である。** 起票前チェック 15 は、最新の `QC-a11y-serious` が確認できない（`E-12` が無い・`ok` でない・14 日を超えた）ときも 0 ではない扱いにする（検査 8 の `LH-seo` と同じ安全側。AA-04 の 3.8）。有効にした後も、`QC-a11y-serious` が 0 でない間は UI を変える提案が `accessibility` だけになる。有効にする時期は DD-09 の 7 節
- **観測 4 本は並列で走り、`proposal-writer` だけが `after` で 4 本を待つ。** 並列に走らせると同じ観測から複数の提案が同時に起票されて `proposal_id` の採番が衝突する
- `seo-auditor` は 3 つの job で動くが、**処理する `source` を job ごとに分けてある**（1 つの `source` のディレクトリに書くエージェントは 1 本だけ。採番が衝突しない）
- `E-13` の起票（`I-13`）は**エージェントではなく builtin** である。エージェントが PR を作れると承認機構（PR のレビュー）に到達できてしまうため
- 時刻と間隔は暫定である。見直すときも PR を通す

### 時刻の決め方（2026-11-03。0〜8 時〈JST〉に収める）

**再帰的自己改善の処理（定期実行）は、日本時間の 0 時から 8 時のあいだに起動し、`timeout_sec` で打ち切られても 8 時までに終わるように置く**（2026-11-03 のユーザーの指示。n8n だけでなく、改善ループの処理すべて）。重い処理（Lighthouse・`astro build`・エージェント）が昼の作業と機械の資源を取り合わなくなる。Lighthouse は機械の負荷で performance が 0.3 以上ぶれるので、静かな時間帯のほうが計測もそろう。

| 時刻（JST） | 動くもの | 終わりの上限（起動 + `timeout_sec`） |
|---|---|---|
| 毎日 00:00 | `published-article-check` | 00:10 |
| 月曜 00:30 → 01:15 | `weekly-lighthouse` → `weekly-a11y`（時刻で重ねない） | 01:00 → 01:45 |
| 月曜 01:45・02:00 | `weekly-observe-lighthouse`・`weekly-observe-a11y`・`weekly-observe-serp-audit` | 02:15 |
| 月・火・水 02:30 | `weekly-keyword-research`（月）・`weekly-content-draft`（火）・`weekly-content-plan`（水） | 02:50 |
| 毎日 04:00 | 観測 4 本（`daily-observe-*`。並列） | 04:20 |
| 毎日 04:30 | `daily-propose`（観測 4 本を `after` で待つ） | 04:45 |
| 毎月 1 日 05:00 | `monthly-analysis`（`daily-propose` と同じ `proposal-writer` なので重ねない。採番の衝突を避ける） | 05:15 |
| 毎日 05:30〜06:15 | `daily-i13-file` → `daily-miswrite-check` → `daily-silence-check` → `daily-n8n-export` | 06:25 |
| 0〜8 時の 15 分ごと | `runlog-flush`（E-15 の写しの送り直し。最後は 07:45） | 07:50 |

- **改善ループの本体はすべて 06:25 までに終わる**（最長の上限）。8 時までの残り 1 時間半は、機械の遅れや手動の再実行のための余白。`runlog-flush` も 07:50 までに終わる
- **本番の Chatwoot（chatwoot-web・chatwoot-worker）と mautic-cron は 22 時〜翌 3 時 45 分に止まっている**（`cloud/template.yaml` の `NightlyStopSchedule`・`NightlyStartSchedule`。`cloud/README.md` の 4.11 の「夜間の停止」）。止まっているあいだ、Chatwoot への要求は ALB の 503 になる（control-plane の分類では `invalid_response`）。**Chatwoot を読む定期実行（`daily-observe-conversations`・`daily-miswrite-check`）は 03:45 より後に置く。** 2026-11-04 まで再開が 8 時で、この 2 本が毎晩失敗していたので、再開を 3 時 45 分に早めた。mautic-web は止めないので、Mautic を読む `daily-observe-analytics` は時刻を選ばない
- **03:00〜03:30 を空けてある。** RDS の保守の窓（`cloud/stacks/data.yaml` の `DbMaintenanceWindow`。日曜 18:00 UTC＝**月曜 03:00 JST**）と重ねない。日次バックアップ（02:00〜02:30 JST）は書き込みを止めないので重なってもよいが、週次の書き込み（02:30〜）はその後に置いた
- 順序は以前と同じ（月曜の計測 → 週次の観測 → 日次の観測 → 提案 → 起票・突き合わせ）。`after` は「当日（JST の 0 時から）`success`」なので、0 時より後に並べれば崩れない。`monthly-analysis` は以前は `daily-i13-file` と同時刻（08:00）で起票が翌日に回っていたが、i13 の前に置いたので当日に PR になる
- 観測の取得範囲は「3 日前まで」「直近 24 時間」の相対指定なので、起動を早めても範囲は変わらない
- **定期実行の定義に無い常駐の処理は、昼も動く**: 監視アプリのハートビート（内部タイマーで 5 分ごとに CloudWatch へ 1 点。止めるとアラーム `comegin-prod-onprem-heartbeat` が鳴る）と、写しの再送（起動時・10 分ごと・各実行の終わり。未送が無ければ何もしない）。どちらも改善の処理ではなく、生存の確認と記録の保全。`heartbeat.yaml` は無効のまま。昼に人が手で起こした実行は、その場で動く（時刻の制限は定期実行だけ）
- 本番の n8n のスケジュールも同じ方針（`weekly-inquiry-inventory` は月曜 07:00、I-11・I-12 の掃除は毎日 03:00・03:05〈月曜は RDS の保守の窓と重なりうるが、保守が入る週はまれで、失敗しても翌日の掃除で取り戻せる。重複排除の行の保持は 7 日〉。5 分ごとのハートビートは例外）。`middleware/n8n/workflows/README.md`

### 定期実行に載せていないエージェント

| エージェント | 理由 |
|---|---|
| `knowledge-scout` | 競合ドメインの指定（1 回 5 件まで）が要るので、管理者の指示で起動する。費用が発生する |
| `quality-checker` | 検査の対象と項目をプロンプトで指定する（指定が無ければ Lighthouse と構造化データだけ）。公開前の下書きの確認は管理者の指示で起動する。**項目 6（WCAG の機械検査）だけは `weekly-observe-a11y` で定期実行する** |
| `design-implementer` | コードの差分を作る仕事で、仕様の指示が要る |
| `lead-ops` | 本番の Mautic への書き込み。トスアップ対象の期間をプロンプトで固定してから、管理者の指示で起動する |

TA-03 の 3.3 の「週次 AB テスト」と「週次 問い合わせの棚卸し」は、担当するエージェントが 12 本の中に無い（前者）か、エージェントを使わず本番の n8n が行う（後者）ため、ここには無い。

## MCP の登録表（`mcp-registry.yaml`）

同じ MCP サーバを開発環境用と本番用に 2 回登録する（ADR-15・ADR-16）。

| 名前 | 種別 | 上限・用途 |
|---|---|---|
| `chatwoot` / `chatwoot-prod` | 自作 stdio（`backend/chatwoot-mcp/dist/index.js`） | `read_write`（登録表の `env_vars` で固定）。`conversation-triage` だけが使う |
| `mautic` / `mautic-prod` | 自作 stdio（`backend/mautic-mcp/dist/index.js`） | `read_write`（`env_vars` で固定。`TRANSPORT: stdio` も `env_vars`）。`lead-ops` だけが使う |
| `mautic-prod-ro` | 同上 | `read_only`（`env_vars` で固定）。`analytics-reporter` だけが使う。**参照専用ロールの別の API 認証情報**を使う |
| `strapi-mcp` / `strapi-prod` | Strapi 組み込み（HTTP `/mcp`）。開発は `127.0.0.1:1337`、本番は**オンプレの本番の Strapi**（`127.0.0.1:1338`。ADR-21、`onprem/strapi`） | 本番は Admin トークンで**下書きまで**（公開・非公開化・削除の権限を与えない） |
| `n8n` / `n8n-prod` | n8n 組み込み（HTTP `/mcp-server/http`）。開発は `127.0.0.1:5678`、本番は**オンプレの本番の n8n のエディターの口**（`127.0.0.1:5679`。ADR-21、`onprem/n8n`） | 本番は作成と更新まで。どのエージェントにも割り当てていない |
| `openseo` | ローカル HTTP | `ACCESS_LEVEL` が無い。許可リストはエージェント定義の `tools`。GA4 も読む（`analytics-reporter` だけ。`get_google_analytics_*` のうち 5 本。OpenSEO に接続するのは本番の GA4 プロパティだけ。ADR-25） |
| `posthog-prod` | HTTP（`https://mcp.posthog.com/mcp?readonly=true&mode=tools&tools=…`） | 読み取り専用。`analytics-reporter` と `ops-watcher` だけが使う。個別ツールの許可リスト（`execute-sql`、`query-error-tracking-*`）。**`mode=tools` が必須**（無いと Claude Code には `exec` 1 本の CLI モードが返り、許可リストのツールが存在しなくなる。2026-11-04 の観測が全件 `permission_denied` になった原因）。個人 API キーも本番用のプロジェクトの読み取りだけで発行する |

- **stdio の登録には `env_vars`（秘密でない定数。`TRANSPORT` と `*_ACCESS_LEVEL`）を書く。** node の `--env-file-if-exists` は既にある環境変数を上書きしないので、env ファイルに別の値が書かれていても登録表の値が勝つ（`ACCESS_LEVEL` を env ファイルで広げられない）。キー名に secret・token・password・api_key などを含む値は登録表に書けない（control-plane が拒否する）
- **MCP の名前に `__` を含めない**（ツールの完全名 `mcp__<name>__<tool>` の区切りと衝突する）
- stdio の `args` の相対パスは `CONTROL_MAIN_CHECKOUT` から解決される。**使う前に `backend/chatwoot-mcp` と `backend/mautic-mcp` で、それぞれ `pnpm install && pnpm build` しておく**（`dist/index.js` を起動する。2 つは別のプロジェクト。main が更新されたらビルドし直す。手順は `onprem/README.md` の「MCP サーバの dist をビルドする」）
- **ツールの許可リストはエージェント定義の `tools`**（完全名）。監視アプリは、そのエージェントの `tools` に出てくる `mcp__<name>__` の登録だけを組み立てて渡す

### env ファイル（リポジトリには置かない）

env ファイルの実体は `~/.config/comegin/mcp/` に置く。エージェントはここを読めない。**ここに載せる変数名は、各プロジェクトの `.env.example` と一致させる。**

| ファイル | 変数 |
|---|---|
| `chatwoot-dev.env` / `chatwoot-prod.env` | `CHATWOOT_BASE_URL` `CHATWOOT_ACCOUNT_ID` `CHATWOOT_API_ACCESS_TOKEN`（`CHATWOOT_ACCESS_LEVEL` と `TRANSPORT` は登録表の `env_vars`）。トークンは `conversation-triage` 専用のエージェントユーザーのもの |
| `mautic-dev.env` / `mautic-prod.env` / `mautic-prod-ro.env` | `MAUTIC_BASE_URL` `MAUTIC_CLIENT_ID` `MAUTIC_CLIENT_SECRET`（`MAUTIC_ACCESS_LEVEL` と `TRANSPORT=stdio` は登録表の `env_vars`）。`mautic-prod-ro` は参照専用ロールの認証情報 |
| `strapi-dev.env` / `strapi-prod.env` | `STRAPI_DEV_TOKEN` / `STRAPI_PROD_TOKEN`（Admin トークン。`strapi-prod` はオンプレの本番の Strapi〈`onprem/strapi`〉の管理画面で発行する） |
| `n8n-dev.env` / `n8n-prod.env` | `N8N_DEV_TOKEN` / `N8N_PROD_TOKEN`（`n8n-prod` はオンプレの本番の n8n〈`onprem/n8n`〉の設定画面で発行する） |
| `posthog-prod.env` | `POSTHOG_PROD_API_KEY`（「MCP Server」プリセットで、本番用のプロジェクトの読み取りだけに絞る）と `POSTHOG_PROD_PROJECT_ID`（`x-posthog-project-id` で本番用のプロジェクトに固定する） |

## 未確認（TODO）

- **`strapi-prod` の `keyword` / `content-plan` のツール名**（`create_keyword`、`list_content-plan` など）は、Strapi の MCP の命名規則（singularName）からの推定。開発環境の `strapi-mcp` の `tools/list` で確かめる（L3-1）。`.claude/agents/` の該当 3 本の frontmatter にも同じ TODO のコメントがある
- n8n（`/mcp-server/http`）の URL とヘッダーは、設計書とソースの読みで書いた。実際の接続は未確認（Umami の登録は ADR-25 で廃止した）
- OpenSEO の GA4 のツール（`get_google_analytics_*`）は上流のソース（`middleware/open-seo-main/src/server/mcp/tools/google-analytics-tools.ts`）の読みで書いた。本番のプロパティを接続した後に `tools/list` と実際の応答で確かめる

## 新しい定期実行を足すとき

1. `schedules/<job-id>.yaml` を作る（`enabled: false`、`kind: agent` なら `prompt` に**取得の範囲を固定**）
2. 使うエージェントの `tools` に無い MCP が要るなら、`.claude/agents/<name>.md` と `mcp-registry.yaml` も変える（広げる変更は承認の対象）
3. PR を作る。レビューで承認されて `main` に入り、`CONTROL_MAIN_CHECKOUT` が更新されてから効く
4. 有効にするのは別の PR（`enabled: true`）
