# mautic-mcp-server

Mautic REST API を MCP ツールとして公開するサーバ（MCP TypeScript SDK v2）。

## 認証の構成

```
MCP クライアント ──(Bearer: MCP_AUTH_TOKEN)──▶ mautic-mcp-server ──(OAuth2 client_credentials)──▶ Mautic API
```

- Mautic のアクセストークンはサーバ内でキャッシュし、期限の 60 秒前に自動で取り直す。401 を受けた場合も 1 回だけ取り直して再試行する。
- client_credentials のトークンにはユーザーが紐づかない。**権限は Mautic の API 認証情報に設定したロールで決まる**ため、参照専用のロールを割り当てることを推奨する。

## ツール

| ツール | 内容 |
|---|---|
| `mautic_list_contacts` | コンタクトの検索・一覧（`search` は Mautic の検索構文。`limit` / `offset` でページング） |
| `mautic_get_contact` | コンタクト 1 件の全フィールドと Do Not Contact 状態 |

いずれも読み取り専用。`response_format` で `markdown`（既定）/ `json` を切り替えられる。

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

stdio で使う場合は `.env` に `TRANSPORT=stdio` を設定する（`MCP_AUTH_TOKEN` は不要）。

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
