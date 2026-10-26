# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリの位置づけ

SaaS 販売事業の「事業経営基盤」のうち、**マーケティング部門の Web サイト運用・SEO 対策**を対象とするモノレポ。
2026-10-11 に `MarketingDepartment/WebsiteOperations/` の下にあったものをすべてリポジトリ直下へ移した（`backend/`・`frontend/`・`middleware/`・`docs/`・`cloud/`・`onprem/`・`ops/`・`setup/`・`integration/`）。
**パスはすべてリポジトリのルートからの相対**で、古い文書（`docs/superpowers/` の計画・仕様など、移動前の記録）に残る `MarketingDepartment/WebsiteOperations/` は読み替える。
事業側のスキーム（役割分担・PDCA 運用）と採用ツールの一覧は `README.md`、4 層（BA/DA/AA/TA）の設計は `docs/README.md` にある。

ドキュメント・コードコメント・スクリプトのヘルプはすべて日本語で書かれている。新規に書くものも日本語に合わせる。

## 自作コードと vendor 取り込みの区別（最重要）

追跡ファイル約 9,000 のうち **8,200 は上流プロジェクトをそのまま取り込んだもの**（2026-10-06 に `middleware/umami-master` を削除した後の数）。
探索・grep・リファクタの対象を間違えないよう、まずここを確認する。

| 種別 | ディレクトリ | 扱い |
|---|---|---|
| 上流をそのまま取り込み | `backend/mautic-system`（Mautic 本体 6,831 ファイル）、`middleware/open-seo-main`（OpenSEO 1,399 ファイル） | 上流のコード。独自の追加は `dev/` 配下のスクリプトのみ。**Umami は ADR-25（2026-10-06）で廃止した**（`middleware/umami-master`・`middleware/umami` は削除済み。アクセス解析の正本は GA4、PostHog は AB テスト・例外の監視・記事のイベント・実測の Core Web Vitals）。`mautic-system/CLAUDE.md` は**上流 Mautic 付属のもので、このリポジトリの方針ではない** |
| 自作（MCP サーバ） | `backend/chatwoot-mcp`、`backend/mautic-mcp` | このリポジトリの主要な自作コード |
| 自作（設定・運用のみ） | `backend/chatwoot-system`、`middleware/n8n`、`middleware/ga4`（2026-10-06。ADR-25） | 公式イメージを動かすための compose と環境変数のテンプレートだけ。`middleware/ga4` は SaaS（GA4）の設定の記録と setup だけで、動かすものは無い（本番のプロパティだけ。開発ではタグを出さない） |
| 自作（アプリ） | `backend/strapi-system`、`frontend/verdant-virgo` | スキャフォールド + 独自の差分 |
| 自作（サービス。2026-10-04 着手） | `backend/consent-api`、`backend/admin-auth` | 本番はどちらも ALB 配下の Lambda（VPC の中。ADR-26。2026-10-12）。consent-api は DB を持たず Valkey だけ。admin-auth は Better Auth を OIDC Provider にして ALB の `authenticate-oidc` の IdP にし、運用（migrate・ALB の登録）は別の Lambda（admin-auth-ops） |
| 自作（サービス。2026-10-11 着手） | `backend/faq-bot` | Chatwoot の受信箱「Web サイト」で FAQ に答えるエージェントボット。**本番は Lambda（VPC の外。関数 URL。ADR-26）**、開発は Node の HTTP サーバー（3107）。FAQ は Astro の `faq.json`（`frontend/verdant-virgo/src/modules/faq-export`）を読む。データの置き場は持たない |
| 自作（管制。2026-10-04 着手） | `backend/control-plane`（ライブラリ）＋ `frontend/next-js`（監視アプリ） | `E-15` の記録（作業ツリーの外の SQLite）・定期実行・Agent SDK でのエージェント起動・`I-13` の起票。**control-plane は next-js が取り込んで 1 プロセスで動かす**。境界の型は `backend/control-plane/src/contract.ts` |
| 自作（IaC・定義） | `cloud/`（AWS SAM。クラウドに置く製品と例外とデータの置き場。デプロイ手順は `cloud/README.md`）、`onprem/`（ADR-21。オンプレの本番の Strapi・n8n と WireGuard の構成）、`middleware/n8n/workflows/`（ワークフローの JSON）、`ops/`（定期実行の定義と MCP の登録表）、リポジトリ直下の `.claude/agents/`（エージェント定義 12 本） | 定期実行の定義とエージェント定義は、監視アプリが**承認済みの `main` のチェックアウトから**読む（ADR-18）。作業ツリーで書き換えても次の実行には効かない |

命名規則: `<プロダクト>-system` = そのプロダクトの実体を動かす場所、`<プロダクト>-mcp` = その API を MCP ツールとして公開する自作サーバ。

## ポートの割り当て

複数スタックを同時に起動する前提で調整済み。新しくポートを使うときはこの表を崩さない。

| ポート | 用途 |
|---|---|
| 3000 | （空き。以前は Umami。ADR-25〈2026-10-06〉で Umami を廃止） |
| 3001 | OpenSEO（UI と MCP の `/mcp`。上流の compose のまま `127.0.0.1` にバインド。`AUTH_MODE=local_noauth` で無認証のため、トンネルを張らない） |
| 3100 | Chatwoot 本体（`CHATWOOT_PORT`）／ **mautic-mcp の HTTP 既定値と衝突する**。両方 HTTP で動かすならどちらかの `PORT` を変える |
| 3102 | chatwoot-mcp（HTTP 時） |
| 3103 | admin-auth（Better Auth の OIDC Provider。本番は `auth.comegin.com`〈ALB 配下の Lambda。ADR-26。ポートを持たない〉。設計は `docs/RequirementDefinition/AA/05-application-decisions.md` の ADR-13・`TA/06-aws-runtime.md` の 5.2） |
| 3104 | consent-api（Cookie 同意の記録。本番は ALB 配下の Lambda〈ADR-26〉で、ポートを持たない。訪問者のリクエストを直接受ける初めての自作コードなので、DB を持たせず ElastiCache だけに書く。設計は `docs/DetailedDesign/02-public-path-flows.md` の 8 節） |
| 3105 | （空き。以前は Cal.com のセルフホスト用。**ADR-24〈2026-10-06〉で Cal.com は SaaS〈cal.com〉を公開サイトの完了画面に埋め込む形にした**ため使わない。予約の氏名・メール・日時は Cal.com, Inc.〈米国〉と Google LLC〈米国〉に渡る。設計は `docs/DetailedDesign/02-public-path-flows.md` の 7 節と `RequirementDefinition/AA/05-application-decisions.md` の ADR-24） |
| 3106 | points-api（採掘の貢献量の取り込みと譲渡不可ポイントの付与。**本システムの完成後に着手**。本番は ALB 配下の ECS on Fargate。設計は `docs/DetailedDesign/08-monetization-flows.md`） |
| 3107 | faq-bot の開発サーバー（`backend/faq-bot` の `pnpm dev`。`127.0.0.1` にバインド。開発の Chatwoot からは host-relay 経由。本番は Lambda の関数 URL でポートを持たない。ADR-26） |
| 3200 | 監視アプリ（`frontend/next-js`。Next.js の既定 3000 は以前 Umami と衝突していたため 3200 を使う〈Umami の廃止後も変えない〉。`127.0.0.1` にバインドする。**開発では ngrok で公開してよい**（ADR-23。`https://comegin-next-js-dev.ngrok.app`。ログインは Google〈Workspace〉だけで、許可リスト `CONTROL_ADMIN_EMAILS` のメールだけが通る）。サーバー側のロジックは `backend/control-plane`。設計は `docs/RequirementDefinition/TA/07-onprem-control-plane.md`） |
| 3201 | 監視アプリの E2E（`frontend/next-js` の `pnpm e2e`。Playwright が E2E 専用のインスタンスを `127.0.0.1` で起動する。サンドボックスの置き場〈一時ディレクトリ〉と `distDir` `.next/e2e` を使い、3200 の記録とロックに触れない。`e2e/support/sandbox.mjs` で固定） |
| 1337 | Strapi（開発環境） |
| 1338 | Strapi（**本番。オンプレ**。ADR-21。データは AWS の RDS・S3。`127.0.0.1` だけに開く。構成は `onprem/strapi`） |
| 4321 / 4322 | Astro dev / Lighthouse CI が使う preview（`lighthouserc.cjs` で固定） |
| 4323 | a11y の自動検査（`pnpm a11y`。Playwright ＋ axe）が使う preview（`playwright.config.ts` で固定。builtin の `a11y` ジョブも同じ。計画は `docs/superpowers/plans/2026-10-18-jis-x-8341-3-accessibility.md`） |
| 4324 | 公開サイトの E2E（`frontend/verdant-virgo` の `pnpm e2e`。Playwright が E2E 専用の Astro dev を `127.0.0.1` で起動し、送信先を開発スタックの `127.0.0.1` に向け直す。`playwright.e2e.config.ts`・`e2e/flows/support/env.ts` で固定） |
| 5432 | Chatwoot の PostgreSQL |
| 5433 | n8n の PostgreSQL |
| 5434 | admin-auth の開発の PostgreSQL（`127.0.0.1` だけ。admin-auth の結合テストが Lambda の入口から直接つなぐ） |
| 5678 | n8n（開発環境） |
| 5679 | n8n（**本番。オンプレ**。ADR-21。データは AWS の RDS。`127.0.0.1` だけに開く。構成は `onprem/n8n`） |
| 5680 | n8n の本番の Webhook の受け口（リバースプロキシ。**WireGuard のアドレスだけ**に開き、`/webhook/*` だけを 5679 に通す。エディター・API はクラウドから届かない） |
| 6380 | consent-api の開発の Valkey（`127.0.0.1` だけ。consent-api の結合テストが Lambda の入口から直接つなぐ） |
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
dev/stop.sh            # serve.sh で起動したもの（PHP・Webhook の定期実行・MySQL と MailHog）を止める。--keep-docker で PHP だけ
dev/reset.sh --help    # DB を消して再インストールする破壊的スクリプト

# middleware/host-relay（開発環境だけ。コンテナ〈n8n・Chatwoot〉から、ホストの 127.0.0.1 の Mautic・MailHog・n8n・Chatwoot・OpenSEO〈health だけ〉に届くようにする中継）
docker compose up -d
```

**開発環境の一式は `setup/setup.mjs` が 1 本で用意する**（`node setup/setup.mjs --target dev [--check]`。各スタックの起動・管理者・トークン・MCP の env ファイル・n8n の取り込み。画面でしかできない操作は止まって案内し、再実行で続きから。手順は `setup/README.md`）。**フロントエンド（公開サイトの Astro と監視アプリ）は `setup/frontend.mjs` が用意する**（`node setup/frontend.mjs --target dev [--check]`。バックエンドの後に実行する。Astro の `.env` はバックエンドが状態に置いたトークン・ID から写す）。モジュールは各ディレクトリの `setup/index.mjs`（上流取り込みのものは `dev/setup/`）で、`setup/lib/core.mjs` の契約に従う（親スクリプトの共通部分は `setup/lib/runner.mjs`）。生成した秘密値は `~/.config/comegin/setup/<target>.state.json` にだけ置き、画面に出さない。

**コンテナからホストの開発環境のサービスへは `host.docker.internal` で届く**（`middleware/host-relay` が docker0 のアドレス〈172.17.0.1〉の 8000・1025・5678・3100・3001・3107 だけで待ち受け、`127.0.0.1` に転送する。3001〈OpenSEO〉は無認証で費用の出る `/mcp` を持つため、`GET /api/health` だけを通す。n8n と Chatwoot の compose に `extra_hosts: host-gateway` を設定済み）。中継に新しいポートを足すときは、`middleware/host-relay/README.md` の表も更新する。本番には置かない。

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
- しきい値は accessibility / best-practices が 0.9（error）、performance は 0.9 を目安に warn（ADR-29。2026-10-19 に動きを優先して error から改めた）、**SEO は 1.0 が死守ライン**（SEO 対策がこの計測の目的）。レポートは外部公開を避けて `./.lighthouse` に出力する。
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
