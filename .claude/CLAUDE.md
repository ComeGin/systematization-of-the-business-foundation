# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリの位置づけ

SaaS 販売事業の「事業経営基盤」を、部門ごとにディレクトリを切って構築するモノレポ。
現在実装があるのは `MarketingDepartment/WebsiteOperations`（マーケティング部門 / Web サイト運用）のみで、
`docs/{AA,BA,DA,TA}` と `cloud/` は空の枠。事業側のスキーム（役割分担・PDCA 運用）と採用ツールの一覧は `README.md` にある。

ドキュメント・コードコメント・スクリプトのヘルプはすべて日本語で書かれている。新規に書くものも日本語に合わせる。

## 自作コードと vendor 取り込みの区別（最重要）

追跡ファイル約 8,700 のうち **8,500 は上流プロジェクトをそのまま取り込んだもの**。自作コードは約 160 ファイルしかない。
探索・grep・リファクタの対象を間違えないよう、まずここを確認する。

| 種別 | ディレクトリ | 扱い |
|---|---|---|
| 上流をそのまま取り込み | `backend/mautic-system`（Mautic 本体 6,831 ファイル）、`middleware/umami-master`（Umami v3.4.0、2,026 ファイル）、`middleware/open-seo-main`（OpenSEO 1,399 ファイル） | 上流のコード。独自の追加は `dev/` 配下のスクリプトのみ。`mautic-system/CLAUDE.md` は**上流 Mautic 付属のもので、このリポジトリの方針ではない** |
| 自作（MCP サーバ） | `backend/chatwoot-mcp`、`backend/mautic-mcp` | このリポジトリの主要な自作コード |
| 自作（設定・運用のみ） | `backend/chatwoot-system`、`middleware/n8n` | 公式イメージを動かすための compose と環境変数のテンプレートだけ |
| 自作（アプリ） | `backend/strapi-system`、`frontend/verdant-virgo` | スキャフォールド + 独自の差分 |

命名規則: `<プロダクト>-system` = そのプロダクトの実体を動かす場所、`<プロダクト>-mcp` = その API を MCP ツールとして公開する自作サーバ。

## ポートの割り当て

複数スタックを同時に起動する前提で調整済み。新しくポートを使うときはこの表を崩さない。

| ポート | 用途 |
|---|---|
| 3000 | Umami（`umami-master/docker-compose.yml` は上流のまま。ループバック限定になっていない） |
| 3001 | OpenSEO（UI と MCP の `/mcp`。上流の compose のまま `127.0.0.1` にバインド。`AUTH_MODE=local_noauth` で無認証のため、トンネルを張らない） |
| 3100 | Chatwoot 本体（`CHATWOOT_PORT`）／ **mautic-mcp の HTTP 既定値と衝突する**。両方 HTTP で動かすならどちらかの `PORT` を変える |
| 3102 | chatwoot-mcp（HTTP 時） |
| 3104 | consent-api（Cookie 同意の記録。ALB 配下の ECS on Fargate。訪問者のリクエストを直接受ける初めての自作コードなので、DB を持たせず ElastiCache だけに書く。設計は `MarketingDepartment/WebsiteOperations/docs/DetailedDesign/02-public-path-flows.md` の 8 節） |
| 3105 | Cal.com（面談の予約。**セルフホスト**。公開サイトの完了画面に埋め込む。Google Calendar と連携し、予約が成立すると訪問者を予定に招待する＝氏名・メール・日時が Google LLC（米国）に渡る。設計は同 7 節と `RequirementDefinition/AA/02-integration-architecture.md` の `I-25`） |
| 3200 | 監視アプリ（`frontend/next-js`。Next.js の既定 3000 は Umami と衝突するため 3200 を使う。`127.0.0.1` にバインドしトンネルを張らない。設計は `docs/RequirementDefinition/TA/07-onprem-control-plane.md`） |
| 1337 | Strapi |
| 4321 / 4322 | Astro dev / Lighthouse CI が使う preview（`lighthouserc.cjs` で固定） |
| 5432 | Chatwoot の PostgreSQL |
| 5433 | n8n の PostgreSQL |
| 5678 | n8n |
| 8000 / 8025 | Mautic（PHP ビルトインサーバー）/ MailHog |

Chatwoot・n8n のホスト側ポートは `127.0.0.1` にバインドしてある。外部公開は ngrok などホスト側のトンネルで行い、
`SITE_URL` / `N8N_WEBHOOK_URL` / `MCP_ALLOWED_HOSTS` / Vite の `allowedHosts` をその URL に合わせる。

## よく使うコマンド

パッケージマネージャは **pnpm 11**（`pnpm-workspace.yaml` が `minimumReleaseAge` / `trustPolicy` / `blockExoticSubdeps` / `allowBuilds` を使うため 11 未満では効かない）。Node は 22 以上（現環境は 24）。

### MCP サーバ（`backend/chatwoot-mcp`、`backend/mautic-mcp`）

```bash
pnpm install
pnpm build          # tsc
pnpm typecheck      # chatwoot-mcp は tsconfig.scripts.json も検査する
pnpm dev            # tsx watch
pnpm start          # chatwoot-mcp=stdio / mautic-mcp=HTTP（既定トランスポートが逆）
pnpm start:http     # chatwoot-mcp のみ
pnpm start:stdio    # mautic-mcp のみ
```

`chatwoot-mcp` には実 API を叩く検証ハーネスがある（**`pnpm build` 済みの `dist/index.js` を stdio 起動するため、先にビルドが必要**）。

```bash
pnpm verify                    # 参照のみ 16 項目
pnpm verify -- --write         # + 書き込み 14 項目（テストデータを作って最後に削除する。本番アカウントに向けない）
pnpm verify -- --write --keep  # 作ったデータを残す（失敗調査用）
pnpm verify -- --verbose
```

単一シナリオだけ走らせる仕組みはないので、絞りたいときは `scripts/verify/scenarios.mts` を直接見る。
`mautic-mcp` は検証ハーネスの代わりに `pnpm seed:test` / `pnpm seed:test -- --delete`（`mcp-test` タグ付きの架空コンタクト 12 件）を持つ。

### Astro フロントエンド（`frontend/verdant-virgo`）

```bash
pnpm dev            # localhost:4321
pnpm build          # SITE_URL 未設定なら意図的に失敗する
pnpm lh             # build → Lighthouse CI（3 回計測の中央値、しきい値未達で失敗）
pnpm lh:report      # 直近の HTML レポートを開く
```

### Strapi（`backend/strapi-system`）

```bash
pnpm dev            # strapi develop（autoReload あり）
pnpm build          # 管理画面のビルド
pnpm start          # autoReload なし
```

### Docker スタック

```bash
# chatwoot-system
./dev/init-env.sh
docker compose run --rm rails bundle exec rails db:chatwoot_prepare   # 初回とイメージ更新後は必須（entrypoint がマイグレーションしない）
docker compose up -d

# middleware/n8n
./dev/init-env.sh
docker compose up -d

# backend/mautic-system（PHP ビルトインサーバー + Docker の MySQL/MailHog）
dev/serve.sh
dev/reset.sh --help    # DB を消して再インストールする破壊的スクリプト
```

## MCP サーバの共通設計

`chatwoot-mcp` と `mautic-mcp` は意図的に同じ構造を取っている。3 つ目を作るときもこれに合わせる（MCP TypeScript SDK **v2**、`@modelcontextprotocol/server` など）。

```
src/index.ts          トランスポート選択（stdio / Streamable HTTP）と register*Tools の呼び出しのみ
src/config.ts         zod で環境変数を検証。失敗時は「変数名と理由だけ」を stderr に出して exit(1)（値は出さない）
src/constants.ts      SERVER_NAME / SERVER_VERSION / CHARACTER_LIMIT / LONG_TEXT_LIMIT
src/resources.ts      汎用 *_record ツールが扱うリソース定義テーブル（パス・レスポンス形状・要約項目・書き込み可否）
src/services/*-client.ts  HTTP クライアント。認証・リトライ・エラー文の整形（describeError）
src/services/results.ts   ツール戻り値の共通処理（後述）
src/tools/*.ts        register*Tools(server, ctx, accessLevel?) を export。参照系と書き込み系はファイルを分ける
src/tools/annotations.ts  READ_ONLY / CREATE / DESTRUCTIVE の 3 種の annotation 定数
```

守っている不変条件:

- **`ACCESS_LEVEL` は「許可されないツールを登録しない」ことで実装する。** 実行時に拒否するのではなくツール一覧に出さない（`read_only` ⊂ `read_write` ⊂ `full`）。`chatwoot-mcp` の verify はこの包含関係を検査している。
- **stdout は MCP の通信専用。** ログは必ず `console.error`（stderr）へ。
- **HTTP トランスポートの認証は固定 Bearer トークン**（`MCP_AUTH_TOKEN`、32 文字以上）。比較は SHA-256 ダイジェスト同士の `timingSafeEqual`。stdio では不要。
- 上流 API への認証はプロダクトごとに違う: Chatwoot は `api_access_token` ヘッダー（**ユーザー紐付き**＝権限も操作履歴もそのユーザー）、Mautic は OAuth2 client_credentials（トークンをプロセス内でキャッシュし期限 60 秒前に更新、401 で 1 回だけ再取得）。
- **モデルに返す前に必ず `sanitize()` を通す。** `secret` / `token` / `password` / `api_key` / `hmac` を含むキーは `[redacted]`、`LONG_TEXT_LIMIT` 超の文字列は `include_long_text=true` がない限り省略する。例外は `NON_SECRET_KEYS`（`website_token` など公開前提の値）。
- **応答サイズは `CHARACTER_LIMIT` に収める。** 一覧系は `fitToLimit()` で件数を半分ずつ減らし、`truncation_message` で「次のページでは取れない」ことを伝える。ページサイズは上流側で固定のため、こちらでは変えられない。
- Markdown / JSON を選べるツールは `formattedResult()` を使い、`structuredContent` には常に JSON を入れる。
- 更新は `PATCH` 相当のみ（Mautic の `PUT` は存在しない ID で新規作成してしまうため使わない）。破壊的操作には `destructiveHint: true` を付け、クライアント側の確認に委ねる。
- 対象外にした API は各 `README.md` の表に理由付きで残す（パスワード変更・送信系 GET など）。同じ判断を繰り返さないため、新たに除外するときも表に追記する。

各ディレクトリの `README.md` にツール一覧と**上流 API の落とし穴**（Chatwoot の `display_id`、固定ページサイズ、チーム変更で担当者が外れる挙動、`Rack::Timeout` 15 秒など）がまとまっている。ツールを触る前に読む。

## Docker スタックの共通方針

- `dev/init-env.sh` が `.env.example` から環境変数ファイルを作り、パスワード・鍵を生成する。**冪等**（未定義・空・example の初期値のままの項目だけ書き換える）で、生成値は画面に出さない。作り直したいときは該当行を空にして再実行する。
- **`N8N_ENCRYPTION_KEY` / Chatwoot の `ACTIVE_RECORD_ENCRYPTION_*` を変えると既存の暗号化データを復号できなくなる。** `POSTGRES_PASSWORD` は DB ボリューム初期化時にしか反映されない。
- n8n の `sandbox-api` / `sandbox-runner-1` には `env_file` を渡さず、必要な変数だけ `compose.yml` の `environment:` で渡す（`sandbox-runner-1` は privileged な Docker-in-Docker ＝ホスト root 相当のため、暗号化キーや DB パスワードを渡さない）。この分離を崩さない。
- `n8nio/n8n` と `n8nio/runners` のバージョンは必ず一致させる（`N8N_VERSION`）。

## Astro / Lighthouse CI

- `astro.config.mjs` は設定ファイル内で環境変数が自動ロードされないため Vite の `loadEnv` で読む。**`SITE_URL` 未設定のビルドは意図的に例外で停止する**（未設定だと sitemap と canonical に localhost が焼き込まれ、警告なく公開されてしまう）。
- `lighthouserc.cjs` が `.cjs` なのは `package.json` が `"type": "module"` のため（LHCI は `require()` で読む）。preview を 4322 に固定するのは、4321 だと Astro が衝突回避で別ポートに逃げて LHCI が dev サーバーを誤計測するため。GUI のない環境なので `chromeFlags: '--headless=new'` が必須。
- しきい値は performance / accessibility / best-practices が 0.9、**SEO は 1.0 が死守ライン**（SEO 対策がこの計測の目的）。レポートは外部公開を避けて `./.lighthouse` に出力する。
- UI は shadcn/ui（`components.json`、style `base-nova`、alias `@/*`）＋ Tailwind v4（Vite プラグイン。設定ファイルではなく `src/styles/global.css`）。

## Strapi の独自差分

スキャフォールドからの差分は PostHog 連携だけ。

- `src/posthog.ts` — クライアントの生成と `capture` / `captureException` / `shutdown` のラッパ。**本番以外では `POSTHOG_PROJECT_TOKEN` / `POSTHOG_HOST` 未設定を例外にする**（イベントが黙って失われるのを防ぐため）。
- `src/index.ts` — `api::article.article` のライフサイクルを購読し、`article_created` / `article_published` / `article_updated` / `article_deleted` を送る。`$process_person_profile: false` で person を作らない。
- `src/middlewares/posthog-error.ts` — `config/middlewares.ts` の `strapi::errors` の直後に `global::posthog-error` として入れる。`ApplicationError` と 4xx の `HttpError` は想定内のクライアント応答として送らない（管理画面の 404 などで誤検知するため）。

## Git 運用

- 作業は Issue 番号付きのブランチ `<Issue番号>-feature-<日本語名>` で行い、PR で main にマージする。
- コミットメッセージは `feature:` / `add:` / `mod:` / `rename:` / `fix:` のプレフィックス（本文は日本語可）。
- ローカルの `main` は origin/main より遅れていることがある。差分を見るときは `origin/main` を基準にする。
- 秘密値を含む環境変数ファイルは追跡しない（各プロジェクトの `.gitignore`）。`.env.example` は必ず同時に更新する。`temp/` はルートの `.gitignore` で除外。

## ディレクトリごとの追加指示

作業するディレクトリに応じて、以下が上位の指示として効く。

- `middleware/n8n` — `AGENTS.md`。ワークフロー・ノード・式・n8n MCP を触るときは、まず `using-n8n-skills-official` メタスキルを読み、そこからの振り分けに従う。スキル本体はリポジトリルートの `.claude/skills/` にある。
- `frontend/verdant-virgo` — `AGENTS.md`（`CLAUDE.md` はそのシンボリックリンク）。dev サーバーは `astro dev --background` で起動し、`astro dev stop|status|logs` で操作する。
- `backend/.claude/skills`、`backend/strapi-system/.claude/skills` — PostHog 連携用のスキル群。
