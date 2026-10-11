# mautic-mcp-server

Mautic REST API を MCP ツールとして公開するサーバ（MCP TypeScript SDK v2）。

## 認証の構成

```
MCP クライアント ──(Bearer: MCP_AUTH_TOKEN)──▶ mautic-mcp-server ──(OAuth2 client_credentials)──▶ Mautic API
```

- Mautic のアクセストークンはサーバ内でキャッシュし、期限の 60 秒前に自動で取り直す。401 を受けた場合も 1 回だけ取り直して再試行する。
- client_credentials のトークンにはユーザーが紐づかない。**権限は Mautic の API 認証情報に設定したロールで決まる**ため、参照専用のロールを割り当てることを推奨する。

## ツール

秘匿情報らしいキー（`secret` / `password` / `token` / `apiKey`）の値は伏せ字にし、1,000 文字を超える文字列（メール本文の HTML など）は `include_long_text=true` を指定しない限り省略する。

### アクセスレベル（`MAUTIC_ACCESS_LEVEL`）

許可されていない書き込みツールは **ツール一覧に登録しない**（モデルからは存在しないように見える）。

| 値 | 公開されるツール |
|---|---|
| `read_only`（既定） | 参照系 14 ツール |
| `read_write` | + `mautic_create_record`、`mautic_update_record` |
| `full` | + `mautic_delete_record` |

- 書き込み対象の `resource` は、下表の参照用 `resource` に `contacts` を加えたもの。
- 更新は `PATCH`（指定したフィールドだけを変更）。Mautic の `PUT` は存在しない ID で新規作成してしまうため使わない。
- 更新・削除のツールには `destructiveHint: true` を付けており、MCP クライアントが実行前に確認を求められる。
- メール / SMS の送信、セグメント・キャンペーンへの追加などの操作系 API は対象外。

### 参照系ツール

| ツール | 対象 |
|---|---|
| `mautic_list_contacts` / `mautic_get_contact` | コンタクトの検索・一覧（Mautic の検索構文）、1 件の全フィールドと Do Not Contact 状態 |
| `mautic_get_contact_activity` | コンタクトのタイムライン（イベント種別・期間で絞り込み） |
| `mautic_get_contact_relations` | コンタクトのノート・セグメント・キャンペーン・会社・デバイス・ポイントグループ |
| `mautic_list_records` / `mautic_get_record` | 標準エンティティの一覧・1 件取得（下表の `resource`） |
| `mautic_list_campaign_contacts` | キャンペーンの参加コンタクト |
| `mautic_list_form_submissions` | フォームの送信内容（コンタクト単位でも可） |
| `mautic_run_report` | 保存済みレポートの実行結果 |
| `mautic_get_dashboard_widget_data` | ダッシュボードウィジェットのデータ（引数なしで種別一覧） |
| `mautic_query_stats` | 統計テーブルの検索（引数なしでテーブル・列一覧） |
| `mautic_list_files` / `mautic_list_themes` | メディアファイル名・テーマ一覧 |
| `mautic_list_lookup` | ポイントアクション種別、ポイントトリガーのイベント種別、Webhook トリガー、コンタクト担当者 |

`mautic_list_records` / `mautic_get_record` の `resource`:

`assets`, `campaigns`, `campaign_events`, `categories`, `companies`, `contact_fields`, `company_fields`, `dynamic_content`, `emails`, `focus`, `forms`, `marketing_messages`, `notes`, `notifications`, `pages`, `point_actions`, `point_groups`, `point_insights`, `point_triggers`, `reports`（一覧のみ）, `roles`, `segments`, `stages`, `tags`, `text_messages`, `tweets`, `users`, `webhooks`

Mautic API の `GET /api/smses/{id}/contact/{contactId}/send` は GET でも SMS を送信するため、対象外にしている。

## セットアップ

1. Mautic 管理画面 > 設定 > API 認証情報 で OAuth2 クライアントを作成する（`client_credentials` が許可されていること）。
2. `.env.example` を `.env` にコピーし、値を設定する。
3. ビルドして起動する。

```bash
pnpm install
pnpm build
pnpm start          # Streamable HTTP: http://127.0.0.1:3100/mcp
pnpm start:stdio    # stdio
```

## Claude Code から接続

```bash
# HTTP
claude mcp add --transport http mautic http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"

# stdio（環境変数は .env から読み込む）
claude mcp add mautic -- node --env-file=<このディレクトリ>/.env <このディレクトリ>/dist/index.js
```

stdio で使う場合は `.env` に `TRANSPORT=stdio` を設定する（`MCP_AUTH_TOKEN` は不要。`.env.example` のまま空にしておけば未設定と同じに扱う）。
`MCP_ALLOWED_HOSTS` も空（空白とカンマだけを含む）なら未設定と同じに扱う。

HTTP の既定ポート 3100 は Chatwoot 本体（`CHATWOOT_PORT`）と同じ。ポートが使用中などで待ち受けられないときは
`[mautic-mcp-server] failed to listen on 127.0.0.1:3100 (EADDRINUSE)` を出して終了するので、`PORT` を変える。

## 動作確認

```bash
npx @modelcontextprotocol/inspector
```

### テストデータ（開発環境のみ）

架空のコンタクト 12 件を、すべて `mcp-test` タグ付きで投入・削除できる。API 認証情報のロールにコンタクトの作成・削除権限が必要。

```bash
pnpm seed:test             # 投入（既に mcp-test があれば中断）
pnpm seed:test -- --delete # 削除
```
