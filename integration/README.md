# 結合テスト（integration/）

オンプレの開発スタック（127.0.0.1）を横断する結合テスト。単体テスト（各パッケージの `tests/`）と違い、**開発スタックの製品には実際に繋ぎ**、開発スタックに無いもの（AWS SDK・PostHog・GitHub・Google・Anthropic Agent SDK）だけをモックする。

前提: `node setup/setup.mjs --target dev` が済んでいること（状態ファイル `~/.config/comegin/setup/dev.state.json`・`dev.conf`・`~/.config/comegin/mcp/*-dev.env` を実行時に読む）。始める前に `tests/helpers/global-setup.ts` が各サービスの疎通を確かめ、足りないものを並べて止まる。

## 実行

```bash
cd integration
pnpm install
pnpm test                                   # 全スイート（ファイルは 1 つずつ順に走る）
IT_SERVICES=chatwoot,mautic pnpm vitest run tests/chatwoot-mcp   # 疎通確認の対象を絞って 1 スイートだけ
pnpm typecheck
```

パッケージの中に置いた結合テスト（そのパッケージの src を直接組み合わせるもの）は、各パッケージで `pnpm test:integration`:

| パッケージ | 中身 |
|---|---|
| `backend/control-plane/integration/` | `createControlPlane` → エンジン → E-15（一時ディレクトリの SQLite）→ builtin。開発の n8n（読むだけ）・Chatwoot に繋ぐ |
| `backend/strapi-system/integration/` | `createStrapi().load()` のインプロセス起動（一時ディレクトリの SQLite）と偽の PostHog（I-01・I-02） |
| `frontend/next-js/integration/` | Route Handler → Better Auth（一時ディレクトリ）→ control-plane。開発の Chatwoot に繋ぐ |

## スイート（tests/）

| フォルダ | 対象 |
|---|---|
| `consent-api/` | 同意の受け口（3104）と Valkey |
| `admin-auth/` | OIDC Provider（3103）と PostgreSQL |
| `host-relay/` | コンテナ → `host.docker.internal` の中継（OpenSEO は `/api/health` だけ通ること） |
| `next-js/` | 監視アプリ（3200）をセッション無しで外から |
| `chatwoot-mcp/`・`mautic-mcp/` | 自作 MCP サーバ（`dist/index.js` を stdio・HTTP で起動）と開発の Chatwoot・Mautic（I-03・I-04） |
| `n8n/` | I-11・I-12・I-19・I-21 と、Mautic のフォーム・Chatwoot のウィジェットからの通し（I-08 → I-11、I-07 → I-12 → I-19） |
| `strapi/` | 開発の Strapi（1337）の Content API と strapi-mcp（I-09・I-16） |

## 開発スタックに対して行うこと

- `it-` で始まる名前のデータ（コンタクト・会話・記事など）を作り、`afterAll` で消す（`tests/helpers/cleanup.ts`）。消し残しは `it-` で探して消す
- n8n の親ワークフロー I-11・I-12 を**テストの間だけ有効にし**、元に戻す
- 障害の確認のため、`consent-api-valkey-1`・`admin-auth-postgres-1`・`open-seo-main-open-seo-1` を数秒ずつ `docker pause` し、必ず `unpause` する。その間はほかの作業で該当サービスが応答しない
- `src` のバグや開発スタックの設定の不足で通らないものは `it.todo` にし、直上のコメントに再現条件と直し方を書いてある
