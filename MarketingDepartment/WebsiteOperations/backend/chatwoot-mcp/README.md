# chatwoot-mcp-server

Chatwoot の **Application API** を MCP ツールとして公開するサーバ（MCP TypeScript SDK v2）。
同じディレクトリ構成の `mautic-mcp` と同じ方針で作っている。

## 認証の構成

```
MCP クライアント ──(stdio。HTTP のときは Bearer: MCP_AUTH_TOKEN)──▶ chatwoot-mcp-server ──(api_access_token ヘッダー)──▶ Chatwoot API
```

- Chatwoot のアクセストークンは**ユーザーに紐づく**。ツールの操作はそのユーザーとして記録され、**権限（管理者 / エージェント）もそのユーザーのロールで決まる**。
  - レポート・監査ログ・ほとんどの設定変更は管理者トークンが必要。
  - 送信したメッセージには、そのユーザーの名前が送信者として表示される。専用のエージェントユーザーを作って使うと、AI 経由の返信が人手の返信と区別できる。
- トークンは Chatwoot の「プロフィール設定 > アクセストークン」で確認する。アカウント側で API が無効だと 403 になる。

## ツール

32 ツール（`CHATWOOT_ACCESS_LEVEL=full` のとき）。秘匿情報らしいキー（`secret` / `token` / `password` / `hmac` を含むキー）の値は伏せ字にし、1,000 文字を超える文字列は `include_long_text=true` を指定しない限り省略する。

### アクセスレベル（`CHATWOOT_ACCESS_LEVEL`）

許可されていない書き込みツールは **ツール一覧に登録しない**（モデルからは存在しないように見える）。

| 値 | 公開されるツール |
|---|---|
| `read_only`（既定） | 参照系 17 ツール |
| `read_write` | + 作成・更新 11 ツール（`chatwoot_send_message`・`chatwoot_add_private_note` を含む） |
| `full` | + 削除・統合 4 ツール |

### 参照系（17）

| ツール | 対象 |
|---|---|
| `chatwoot_get_account` | アカウント設定、接続中ユーザーの権限、このサーバのアクセスレベル |
| `chatwoot_list_conversations` / `chatwoot_filter_conversations` | 会話の一覧（受信箱・状態・担当・ラベル・全文検索）／条件指定の絞り込み |
| `chatwoot_get_conversation` / `chatwoot_list_messages` | 会話 1 件の詳細／メッセージ履歴（メッセージ ID でのページング） |
| `chatwoot_list_contacts` / `chatwoot_filter_contacts` / `chatwoot_get_contact` | コンタクトの検索・一覧／条件指定の絞り込み／1 件の全項目 |
| `chatwoot_list_records` / `chatwoot_get_record` | 設定系リソースの一覧・1 件取得（下表の `resource`） |
| `chatwoot_get_related` | 関連データ（コンタクトの会話・ラベル・連絡可能な受信箱、会話のラベル・計測イベント、受信箱のメンバー・ボット・WhatsApp テンプレート、チームのメンバー） |
| `chatwoot_get_report_summary` / `chatwoot_get_report_timeseries` / `chatwoot_get_report_breakdown` | 期間の KPI（前期間との比較付き）／時系列／担当者・受信箱・チーム・ラベル・チャネル別 |
| `chatwoot_get_live_conversation_stats` | 現在の未対応・未割り当て件数 |
| `chatwoot_list_reporting_events` / `chatwoot_list_audit_logs` | 計測イベントの生データ／監査ログ（Enterprise の `audit_logs` 機能が必要） |

### 書き込み系（`read_write` 以上、11）

| ツール | 対象 |
|---|---|
| `chatwoot_send_message` | 会話への返信・社内メモ（`private=true`）。`private=false` は**顧客に即時送信される** |
| `chatwoot_add_private_note` | 会話への**社内メモだけ**を作る。入力に `private` を持たず（渡すと拒否される）、顧客には送られない。**本番のエージェントは `chatwoot_send_message` ではこちらを使う**（`conversation-triage` は `chatwoot_send_message` を許可リストに入れず `disallowedTools` に明示する） |
| `chatwoot_update_conversation` | 状態・優先度・担当者・チーム・ラベル・カスタム属性をまとめて変更 |
| `chatwoot_create_conversation` | 既存コンタクトとの会話を新規作成（初回メッセージも送信可） |
| `chatwoot_create_contact` / `chatwoot_update_contact` | コンタクトの作成／更新（ラベル・カスタム属性の追加削除を含む） |
| `chatwoot_create_record` / `chatwoot_update_record` | 設定系リソースの作成／更新 |
| `chatwoot_update_account` | アカウント設定（名前・ロケール・自動解決など） |
| `chatwoot_set_members` | 受信箱・チームのメンバー変更（add / remove / replace） |
| `chatwoot_set_inbox_agent_bot` | 受信箱へのエージェントボットの接続・解除 |

### 削除系（`full` のみ、4）

`chatwoot_delete_record`、`chatwoot_delete_contact`、`chatwoot_delete_message`、`chatwoot_merge_contacts`（統合されたコンタクトは削除される）。

### `chatwoot_list_records` などの `resource`

`agents`, `inboxes`, `labels`, `teams`, `canned_responses`, `custom_attribute_definitions`, `automation_rules`, `custom_filters`, `webhooks`, `agent_bots`, `integration_apps`, `integration_hooks`（作成・更新・削除のみ）, `portals`, `portal_categories`（作成のみ）, `portal_articles`（作成のみ）

- `portals` とその配下は数値 ID ではなく **slug** で指定する。
- 書き込み時のリクエスト本文は、Chatwoot のコントローラが要求するキー（`label` / `team` / `webhook` など）で自動的に包む。

### 対象外にした API

| API | 理由 |
|---|---|
| `PUT /profile` | パスワード変更を含む自分自身のプロフィール操作のため |
| `POST /conversations/{id}/toggle_typing_status` | 画面上の「入力中」表示専用 |
| `PATCH /conversations/{id}/messages/{id}`（配信状態の更新） | 外部チャネル連携が配信結果を書き戻すための API |
| `GET/PATCH /branded_email_layout` | メールテンプレート（Liquid HTML）の編集は画面で行う想定 |
| `POST /contacts/{id}/contact_inboxes` | `chatwoot_create_conversation` が内部で作成するため |

## Chatwoot 側の仕様で気をつける点

- **会話の ID は画面の `#番号`**（`display_id`）。内部 ID とは別。
- **ページ件数はサーバ固定**（会話 25 / コンタクト 15 / メッセージ 20 / 監査ログ・計測イベント 25）。ツールは `page` で進める。
- **チームを変更すると、そのチームに属さない担当者は自動的に外れる**（`ensure_assignee_is_from_team`）。`chatwoot_update_conversation` はチーム → 担当者の順に適用し、反映されなかった場合は警告を返す。
- 担当者にできるのは、その**受信箱のメンバー**であるエージェントだけ（`chatwoot_set_members` で追加する）。
- 会話一覧で `q`（本文検索）を指定すると、`status` の絞り込みは無視される。
- コンタクト一覧（検索なし）は、メール・電話番号・identifier のいずれかを持つコンタクトだけを返す。
- Chatwoot は `Rack::Timeout` により 15 秒でリクエストを打ち切る。起動直後の 1 回目は 500 になることがあり、その場合は再試行する。

## セットアップ

1. Chatwoot の「プロフィール設定 > アクセストークン」からトークンを取得する（専用のエージェントユーザー推奨。レポートや設定変更を使うなら管理者権限が必要）。
2. `.env.example` を `.env` にコピーし、値を設定する。
3. ビルドして起動する。

```bash
pnpm install
pnpm build
pnpm start        # stdio（既定）
pnpm start:http   # Streamable HTTP: http://127.0.0.1:3102/mcp
```

## Claude Code から接続

```bash
# stdio（環境変数はこのディレクトリの .env から読み込む）
claude mcp add chatwoot -- node --env-file=<このディレクトリ>/.env <このディレクトリ>/dist/index.js

# HTTP
claude mcp add --transport http chatwoot http://127.0.0.1:3102/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

HTTP で使う場合は `.env` に `TRANSPORT=http` と `MCP_AUTH_TOKEN`（32 文字以上）を設定する。
stdio では `MCP_AUTH_TOKEN` は不要で、`.env.example` のまま空にしておけば未設定と同じに扱う（`MCP_ALLOWED_HOSTS` も、空なら未設定と同じ）。
ポートが使用中などで待ち受けられないときは `[chatwoot-mcp-server] failed to listen on 127.0.0.1:3102 (EADDRINUSE)` を出して終了するので、`PORT` を変える。

## 動作確認

`scripts/verify/` に、MCP クライアント（`@modelcontextprotocol/client`）で `dist/index.js` を stdio 起動し、
実際の Chatwoot に対してツールを呼ぶ確認スクリプトがある。**先に `pnpm build` が必要**。

```bash
pnpm verify                  # 参照のみ（Chatwoot の状態を変えない）16 項目
pnpm verify -- --write       # 上記 + 書き込み 15 項目（テストデータを作り、最後に削除する）
pnpm verify -- --write --keep  # 作ったデータを残す（失敗時の調査用）
pnpm verify -- --verbose     # 各ツールの応答も表示する
```

確認する内容:

| 区分 | 内容 |
|---|---|
| ツール定義 | 説明・入力スキーマ・注釈が全ツールにあること、`CHATWOOT_ACCESS_LEVEL` で公開範囲が read_only ⊂ read_write ⊂ full になること |
| 参照 | アカウント情報、会話・コンタクト・全設定リソースの一覧、レポート 4 種（管理者トークンでないときはスキップ） |
| エラー | 存在しない ID・未知の属性キー・ありえない日付・誤った関連指定で、次の手順を示すエラーになること |
| 書き込み | 受信箱・ラベル・チーム・コンタクト・会話の作成 → 返信と社内メモ（専用ツールが private を拒否し、private として記録されること）→ 会話のまとめて更新（担当者がチーム変更で外れないこと）→ フィルタ検索 → メッセージ削除 → レポート反映 → 後片付け |

- `--write` は**実際に Chatwoot へ書き込む**ため、本番アカウントに向けて実行しないこと。作成するデータは `mcp-verify-<英数字>` の名前で、最後に削除する（失敗しても後片付けは実行される）。
- 受信箱は、API チャネルの受信箱があればそれを使い、無いときだけ作成する。受信箱の削除ツールは公開していないため、その場合の後片付けだけ REST API を直接呼ぶ。
- Chatwoot の 15 秒打ち切り（`Rack::Timeout`）に当たった場合は、3 秒待って 1 度だけ再試行する。

手動で個々のツールを試す場合は MCP Inspector を使う。

```bash
npx @modelcontextprotocol/inspector
```
