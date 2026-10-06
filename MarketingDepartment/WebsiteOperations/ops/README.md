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

### 一覧（すべて `enabled: false`）

| id | 種類 | 実行 | 内容 |
|---|---|---|---|
| `daily-observe-seo` | agent | 毎日 06:00 | `seo-auditor`。GSC の実績（`source: gsc`） |
| `daily-observe-analytics` | agent | 毎日 06:00 | `analytics-reporter`。GA4（OpenSEO 経由）・Mautic（参照専用）・PostHog の集計 |
| `daily-observe-conversations` | agent | 毎日 06:00 | `conversation-triage`。未解決の会話の一次切り分け（社内メモのみ） |
| `daily-observe-ops` | agent | 毎日 06:00 | `ops-watcher`。直近 24 時間の例外 |
| `daily-propose` | agent | 毎日 07:00 | `proposal-writer`。**観測 4 本を `after` で待つ**。起票前チェック 14 項目を通したものだけ起票 |
| `monthly-analysis` | agent | 毎月 1 日 08:00 | `proposal-writer`。順位・流入・CVR の月次の判断 |
| `weekly-lighthouse` | builtin | 毎週月曜 05:00 | `pnpm lh`（`lighthouse`） |
| `weekly-observe-lighthouse` | agent | 毎週月曜 06:15 | `seo-auditor`。計測の完了を `after` で待ち、`source: lighthouse` に正規化 |
| `weekly-observe-serp-audit` | agent | 毎週月曜 06:30 | `seo-auditor`。ランク追跡とサイト監査の保存済みの結果（`serp` `site_audit`） |
| `weekly-keyword-research` | agent | 毎週月曜 09:00 | `keyword-researcher`。**費用が発生する**（1 回 2,000 クレジットまで） |
| `weekly-content-draft` | agent | 毎週火曜 10:00 | `content-writer`。承認済みの企画から下書きを 1 本（公開は `R2`） |
| `weekly-content-plan` | agent | 毎週水曜 10:00 | `content-planner`。採用済みのキーワードから企画を起案 |
| `heartbeat` | builtin | 5 分ごと | ハートビート（CloudWatch）。途絶えたら改善ループが止まっている |
| `runlog-flush` | builtin | 15 分ごと | `E-15` の写しを S3 に追記（送れていない分を送り直す） |
| `daily-i13-file` | builtin | 毎日 08:00 | `I-13`。`draft` の `E-13` から GitHub に PR を作る |
| `daily-miswrite-check` | builtin | 毎日 08:15 | 誤った書き込みの突き合わせ |
| `daily-silence-check` | builtin | 毎日 08:30 | 沈黙の検出 |
| `daily-n8n-export` | builtin | 毎日 08:45 | 本番の n8n のワークフローを Public API で読み、差分があれば GitHub に PR（`chore/n8n-export-YYYYMMDD`）。作業ツリーには書かない。**有効化の前に、API キーのスコープ（Enterprise のみ）を人が判断する**（`backend/control-plane/README.md` の n8n-export） |
| `published-article-check` | builtin | 6 時間ごと（暫定） | 公開された記事の確認。あればビルドと計測を起こす |

- **観測 4 本は並列で走り、`proposal-writer` だけが `after` で 4 本を待つ。** 並列に走らせると同じ観測から複数の提案が同時に起票されて `proposal_id` の採番が衝突する
- `seo-auditor` は 3 つの job で動くが、**処理する `source` を job ごとに分けてある**（1 つの `source` のディレクトリに書くエージェントは 1 本だけ。採番が衝突しない）
- `E-13` の起票（`I-13`）は**エージェントではなく builtin** である。エージェントが PR を作れると承認機構（PR のレビュー）に到達できてしまうため
- 時刻と間隔は暫定である。見直すときも PR を通す

### 定期実行に載せていないエージェント

| エージェント | 理由 |
|---|---|
| `knowledge-scout` | 競合ドメインの指定（1 回 5 件まで）が要るので、管理者の指示で起動する。費用が発生する |
| `quality-checker` | 検査の対象と項目をプロンプトで指定する（指定が無ければ Lighthouse と構造化データだけ）。公開前の下書きの確認は管理者の指示で起動する |
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
| `posthog-prod` | HTTP（`https://mcp.posthog.com/mcp?readonly=true`） | 読み取り専用。`analytics-reporter` と `ops-watcher` だけが使う。個別ツールの許可リスト（`execute-sql`、`query-error-tracking-*`）。個人 API キーも本番用のプロジェクトの読み取りだけで発行する |

- **stdio の登録には `env_vars`（秘密でない定数。`TRANSPORT` と `*_ACCESS_LEVEL`）を書く。** node の `--env-file-if-exists` は既にある環境変数を上書きしないので、env ファイルに別の値が書かれていても登録表の値が勝つ（`ACCESS_LEVEL` を env ファイルで広げられない）。キー名に secret・token・password・api_key などを含む値は登録表に書けない（control-plane が拒否する）
- **MCP の名前に `__` を含めない**（ツールの完全名 `mcp__<name>__<tool>` の区切りと衝突する）
- stdio の `args` の相対パスは `CONTROL_MAIN_CHECKOUT` から解決される。**使う前に `backend/chatwoot-mcp` と `backend/mautic-mcp` を `pnpm build` しておく**（`dist/index.js` を起動する）
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
- **`posthog-prod` のツール名**（`execute-sql`、`query-error-tracking-issues-list`、`query-error-tracking-issue`）は PostHog の公式の説明から。接続して `tools/list` で確かめる
- n8n（`/mcp-server/http`）の URL とヘッダーは、設計書とソースの読みで書いた。実際の接続は未確認（Umami の登録は ADR-25 で廃止した）
- OpenSEO の GA4 のツール（`get_google_analytics_*`）は上流のソース（`middleware/open-seo-main/src/server/mcp/tools/google-analytics-tools.ts`）の読みで書いた。本番のプロパティを接続した後に `tools/list` と実際の応答で確かめる

## 新しい定期実行を足すとき

1. `schedules/<job-id>.yaml` を作る（`enabled: false`、`kind: agent` なら `prompt` に**取得の範囲を固定**）
2. 使うエージェントの `tools` に無い MCP が要るなら、`.claude/agents/<name>.md` と `mcp-registry.yaml` も変える（広げる変更は承認の対象）
3. PR を作る。レビューで承認されて `main` に入り、`CONTROL_MAIN_CHECKOUT` が更新されてから効く
4. 有効にするのは別の PR（`enabled: true`）
