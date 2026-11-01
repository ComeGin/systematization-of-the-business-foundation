# バックエンド・フロントエンド全体の設定スクリプト（setup/）

オンプレの開発環境（`--target dev`）を、1 本のコマンドで最初から最後まで用意する。
各製品の起動・管理者の作成・トークンの発行・MCP の env ファイル・n8n のワークフローの取り込みまでを、**公式の CLI と API だけで**行う。
画面でしかできない操作に当たると、手順を表示して止まる。終わったら同じコマンドを実行し直せば、済んだ手順は飛ばして続きから進む。

本番（`--target prod`）は、外部の値の形式の確認（GA4）・OpenSEO・admin-auth の確認・オンプレの確認・本番の Chatwoot と Mautic の API でできる初期設定（`chatwoot-prod`・`mautic-prod`）・本番の MCP の env ファイル（`mcp-prod`）まで。画面でしかできないこと（Chatwoot の onboarding、Mautic のインストールと設定）と AWS への書き込み（Secrets Manager・運用の Lambda）は、案内して止まり、人が行う。

**全体の順番（設定スクリプトが確かめない AWS・オンプレの手順を含む）と、人が行う作業の一覧は [`docs/runbooks/00-setup-overview.md`](../docs/runbooks/00-setup-overview.md)。** 段階 `apps` の前提（DB の作成・ECS の台数）と本番の n8n の provision は、2026-10-28 からスクリプトが確かめる・行う。それでも確かめられない手順（公開サイトのビルドと配信など）は、そちらの 4 節にある。

親スクリプトは 2 本ある。**バックエンド全体**（`setup/setup.mjs`）を先に、**フロントエンド全体**（`setup/frontend.mjs`。公開サイトと監視アプリ）を後に実行する（[フロントエンド全体](#フロントエンド全体setupfrontendmjs)）。オプション・終了コード・設定ファイル・状態ファイルは 2 本で共通（引数の解釈と実行の順番は `setup/lib/runner.mjs`）。

## 使い方

```bash
cd ~/ComeGin/systematization-of-the-business-foundation   # リポジトリのルート

# 1. 設定ファイルを用意する（最初の 1 回。必須は ADMIN_EMAIL だけ）
mkdir -p ~/.config/comegin/setup && chmod 700 ~/.config/comegin/setup
cp setup/setup.conf.example ~/.config/comegin/setup/dev.conf && chmod 600 ~/.config/comegin/setup/dev.conf
#    → エディタで ADMIN_EMAIL を書く

# 2. 何も変えずに、どこまで用意できているかを見る
node setup/setup.mjs --target dev --check

# 3. 実行する（止まったら案内に従い、同じコマンドを実行し直す）
node setup/setup.mjs --target dev
```

| オプション | 意味 |
|---|---|
| `--phase <段階>` | **prod だけ**。その段階だけを実行する（下の「本番の段階」）。省略すると `env` から `apps` までを順に進める。`google` は明示したときだけ動く。dev に付けたとき・無い段階のときは、何もせずに `1` で終わる |
| `--check` | 何も変えずに、各モジュールの状態を表示する |
| `--only <id,...>` | 指定したモジュールだけ（id は `--list` で見る） |
| `--from <id>` | 指定したモジュールから後ろだけ（失敗したあとに続きから） |
| `--list` | モジュールの一覧と順番 |
| `--show <KEY>` | 状態ファイルの値を 1 つ表示する（作った管理者のパスワードなど。**秘密値も表示する**） |
| `--config <path>` | 設定ファイルの場所を変える（指定したファイルが無ければ、何も実行せずに `1` で終わる。省略時の既定の場所に無いのは初回として空の設定で進む） |

`--only`・`--from`・`--show`・`--config` の値が無い・空・次のオプション（`-` で始まる）のとき、`--only`・`--from` に `--list` に無い id（この target では動かないものを含む）を渡したときは、何も実行せずに `1` で終わる。

終了コード: `0` 終わった／`1` 失敗（直してから `--from <id>`）／`3` 画面の操作が必要（案内に従って再実行）。

## 本番の段階（`--target prod`）

本番は次の 5 段階の順に進める（2026-10-27。ユーザーの決定）。各モジュールは `meta.phases` で自分の段階を宣言し、親スクリプトが段階の順 → `MODULES` の順に並べて呼ぶ。AWS への書き込み（デプロイ・プッシュ・Secret の値）と画面の操作は、案内して止まる（スクリプトは読み取りで確かめるだけ）。

| 順 | 段階（`--phase`） | すること | モジュール |
|---|---|---|---|
| 1 | `env` | 本番用の環境変数の設定: 道具（aws・sam 1.154 以上・docker・pnpm 11）・AWS の認証とアカウント・`cloud/samconfig.toml` の必須の値（`RunLogAdminPrincipalArns`・`GoogleClientId`・`AdminBootstrapEmails`） | `cloud` |
| 2 | `deploy` | `sam build` → `sam deploy`（1 回目）: global（us-east-1）→ その出力を `CloudFrontCertificateArn`・`CloudFrontWebAclArn` に書く → 本番スタック → 人が入れる Secret の値（`admin-auth/GOOGLE_CLIENT_SECRET` は必須、SMTP の 4 つは DesiredCount を上げる前でよいので警告だけ） | `cloud` |
| 3 | `images` | 派生イメージ（Chatwoot・Mautic）のビルドと ECR へのプッシュ。本番スタックのパラメータ `ChatwootImageTag`・`MauticImageTag` のタグが ECR にあるかを見る（タグを変えたら `samconfig.toml` に書いて `sam deploy` をもう 1 回） | `cloud` |
| 4 | `apps` | 本番のアプリの設定。先頭の `cloud` が前提を確かめる（DB 作成のタスクのログ〈無ければ止まる〉、global の 2 回目・SNS の購読・SES・DMARC・WireGuard の AMI の固定・オンプレの IAM のキー・SMTP の Secret〈警告だけ〉）。`chatwoot-prod`・`mautic-prod` は ECS の台数（親のパラメータの DesiredCount）を確かめ、0 なら上げる手順を案内して止まる | `cloud`・`admin-auth`・`onprem`・`chatwoot-prod`・`mautic-prod`・`n8n-prod`・`mcp-prod`／（frontend.mjs）`verdant-virgo` |
| 5 | `google` | 公開サイトが Route 53 から配信された後（`cloud/README.md` の 4.14）に `--phase google` で行う。GA4 のプロパティ・OpenSEO の Search Console と GA4 の接続・公開サイトの測定 ID と Search Console の所有権 | `ga4`・`openseo`／（frontend.mjs）`ga4`・`verdant-virgo` |

**ECR のリポジトリは `sam deploy` が作る**（`cloud/stacks/ecr.yaml`）ので、イメージのプッシュはデプロイの後になる。ECS のサービスは 0 台で作られ、タスク定義はイメージの有無を検査しないので、イメージが無くても 1 回目のデプロイは通る（`cloud/README.md` の 4.2）。admin-auth・consent-api・faq-bot は Lambda で、ECR を使わない（`sam build` がまとめる）。

```bash
node setup/setup.mjs --target prod --check          # 段階 env〜apps の状態を見る（AWS には読み取りだけ）
node setup/setup.mjs --target prod                  # env → deploy → images → apps（止まったら案内に従い、同じコマンドを実行し直す）
node setup/setup.mjs --target prod --phase images   # 1 つの段階だけ
node setup/frontend.mjs --target prod               # 段階 apps: 公開サイトの .env.production（測定 ID は空。タグを出さない）
# 公開サイトを配信し、Route 53 で届くようになったら
node setup/setup.mjs --target prod --phase google
node setup/frontend.mjs --target prod --phase google   # 測定 ID を入れて書き直す（そのあとビルドし直す）
```

## モジュール（実行の順）

| id | 場所 | 自動でやること | 止まって頼むこと（manual） |
|---|---|---|---|
| `host-relay` | `middleware/host-relay/setup/` | 中継の起動（172.17.0.1 の 8000・1025・5678・3100・3001・3107） | なし |
| `chatwoot` | `backend/chatwoot-system/setup/` | init-env・DB の準備（イメージが変わったときだけ）・起動・Webhook の私設アドレスへの送信の許可（下の「Webhook の送り先と SSRF 対策」）・管理者とアカウント・管理者のトークン・エージェント専用ユーザー（担当者の権限）とトークン・Web サイトの受信箱とメンバー（エージェント専用ユーザーと管理者）・解決後は新しいチャットにする（`allow_messages_after_resolved: false`）・ラベル 4 つ（`faq-answered` ほか）・エージェントボット「FAQ ボット」と受信箱への接続・マクロ「解決の確認を送る」（ラベル `faq-ask-resolved` を付ける）・担当者への引き継ぎのメール通知（管理者の「新しい会話」のメール。届き先は Chatwoot の MailHog〈8026〉）。onboarding 画面を閉じる | 管理者が既にいてパスワードが分からない（`CHATWOOT_ADMIN_PASSWORD` を書くか `CHATWOOT_RESET_ADMIN_PASSWORD=yes`） |
| `mautic` | `backend/mautic-system/dev/setup/` | MySQL・MailHog と PHP サーバーの起動（端末から切り離す。ログは `~/.config/comegin/setup/mautic-serve.log`）・未インストールならインストール・Webhook の設定（送り先の私設アドレスの許可・失敗での自動停止の無効化）・カスタム項目 3 つ・フォーム `consult`（`source_dl` は 2026-10-20 にやめた）・セグメント `mql` | **API 資格情報の作成**（画面だけ。下の「画面での操作」） |
| `ga4` | `middleware/ga4/setup/`（dev・prod） | **dev**: 開発の Astro の環境変数に測定 ID が無いことの確認だけ（あれば失敗）。**prod**: `GA4_PROPERTY_ID`（数字）と `GA4_MEASUREMENT_ID`（`G-…`）の形式の確認（GA4 は SaaS。API は呼ばない。ADR-25）。prod は段階 `google` | prod だけ: 本番の GA4 プロパティの作成と設定（`ga4:property`） |
| `openseo` | `middleware/open-seo-main/dev/setup/`（dev・prod） | 環境変数ファイル（空のキーだけ。`BETTER_AUTH_SECRET` を生成、`AUTH_MODE=local_noauth`）・起動・`/api/health` の確認 | DataForSEO のキー／**prod だけ**（prod は段階 `google`。dev は AWS に展開されていないので飛ばす）: Search Console と GA4 用の OAuth クライアント（GA4 は Analytics Admin API・Data API の有効化と `/api/ga4/oauth/callback` を含む）／Search Console の接続（画面）／GA4 の接続（画面。本番のプロパティだけ。ADR-25） |
| `strapi` | `backend/strapi-system/setup/` | 環境変数ファイル・`pnpm install`・管理者（0 人のときだけ）・MCP 用の Admin トークン（下書きまで）・ビルド用の読み取りトークン → `strapi-dev.env` | 開発サーバーの起動（別の端末で `pnpm dev`）／既にいる管理者のパスワード |
| `n8n` | `middleware/n8n/setup/` | init-env・起動・オーナー・公開 API のキー・MCP の有効化とトークン → `n8n-dev.env`・provision（Data Table・Mautic と Chatwoot の Webhook・資格情報・ワークフローの取り込みと子の公開） | 既にいるオーナーのパスワード／作成済みの MCP トークン（写すか `N8N_MCP_ROTATE=true`） |
| `consent-api` | `backend/consent-api/setup/` | 環境変数ファイル・起動（Valkey 付き）・`/healthz` | なし |
| `admin-auth` | `backend/admin-auth/setup/`（dev・prod） | **dev**: init-env・起動・discovery と JWKS の確認。許可リストに `ADMIN_EMAIL`。**prod**: 本番の discovery を読むだけ（AWS には書き込まない） | dev: なし（Google の資格情報は任意。無ければ警告だけ）／prod: 運用の Lambda での `migrate`・`register-alb-client`（人が実行して `ADMIN_AUTH_PROD_READY=yes`。`manual-steps.md` の 8.1） |
| `chatwoot-mcp` | `backend/chatwoot-mcp/setup/` | `pnpm install`・`pnpm build`・トークンの確認 → `chatwoot-dev.env` | なし |
| `faq-bot` | `backend/faq-bot/setup/` | 状態のボットのトークンと secret を環境変数ファイルに写す・`pnpm install`・開発サーバーの死活の表示 | 開発サーバーの起動（別の端末で `pnpm dev`） |
| `mautic-mcp` | `backend/mautic-mcp/setup/` | `pnpm install`・`pnpm build`・資格情報の確認 → `mautic-dev.env` | なし（資格情報が無ければ失敗。mautic を先に） |
| `control-plane` | `backend/control-plane/setup/` | Node と pnpm の版の確認・`pnpm install`・`pnpm build`・E-15 の置き場（700） | なし |
| `next-js` | `frontend/next-js/setup/` | init-env・`CONTROL_*` の値・Google の資格情報と許可リスト（`CONTROL_ADMIN_EMAILS`）・`pnpm install`・Google ログインを始められるかの確認（認可 URL の `hd` とリダイレクト URI） | `CONTROL_MAIN_CHECKOUT` が無い（失敗として止まる）／**Google の OAuth クライアントの作成**／監視アプリの起動・起動し直し（別の端末で `pnpm dev`） |
| `cloud` | `cloud/setup/`（prod だけ。段階 `env`・`deploy`・`images`・`apps`。AWS を読む部品は `cloud/setup/aws.mjs` で、`chatwoot-prod`・`mautic-prod`・`n8n-prod` も使う） | 読み取りだけの確認（上の「本番の段階」）: 道具・AWS の認証とアカウント（既定 `798560359429`。違えば `prod.conf` の `AWS_ACCOUNT_ID`）・`samconfig.toml` の必須の値（値は表示しない）・global と本番のスタックの状態・人が入れる Secret に値があるか（値は読まない）・ECR のタグ／段階 `apps`: DB 作成のタスクの成功のログ（今のスタックの作成の後。確かめたら状態に残す。ログは 30 日で消えるため）と、警告だけの 7 項目 | `cloud:env`・`cloud:global`・`cloud:cloudfront-params`・`cloud:sam-deploy`・`cloud:secrets`・`cloud:push`・`cloud:db-init`（`manual-steps.md` の 8.5） |
| `onprem` | `onprem/setup/`（prod だけ） | 読むだけの確認（wg0・systemd・待ち受け） | 本番の立ち上げ手順の案内（枠だけ） |
| `chatwoot-prod` | `backend/chatwoot-system/setup/prod/`（prod だけ） | 最初に ECS の `chatwoot-web`・`chatwoot-worker` の DesiredCount（親のパラメータ）が 1 以上か（0 なら `db:chatwoot_prepare` と台数の上げ方を案内して止まる）。開発の `chatwoot` と同じ API の手順を、本番（`https://chat.comegin.com`。ALB のルール 201）に向けて行う: 受信箱「Web サイト」（解決後は新しいチャット・管理者とエージェント専用ユーザーをメンバーに）・FAQ のラベル 4 つ・FAQ ボット（送り先は本番の faq-bot の関数 URL）と受信箱への接続・マクロ・管理者の引き継ぎのメール通知。website_token を prod の状態に置く（公開サイトの本番のビルドが読む） | `chatwoot-prod:ecs`（台数を上げる）／最初の管理者（画面の onboarding）とエージェント専用ユーザーとそれぞれのトークン／FAQ ボットのトークンと secret を Secrets Manager に入れる（`manual-steps.md` の 8.3） |
| `mautic-prod` | `backend/mautic-system/dev/setup/prod/`（prod だけ） | 最初に `mautic-web` の DesiredCount が 1 か、最後に `mautic-cron` の DesiredCount が 1 か（インストールの後に上げる）。開発の `mautic` と同じ API の手順を、本番（`https://mkt.comegin.com`。ALB のルール 202）に向けて行う: カスタム項目 3 つ・フォーム consult と自動返信・セグメント mql。フォームの ID を prod の状態に置く | `mautic-prod:ecs-web`・`mautic-prod:ecs-cron`（台数を上げる）／インストール（`/installer`）と画面の設定（API・Webhook のキューモードと私設アドレス `10.99.0.2`・CORS・メール）と初期設定用の API 認証情報（`manual-steps.md` の 8.4） |
| `n8n-prod` | `middleware/n8n/setup/prod/`（prod だけ） | オンプレの本番の n8n（`127.0.0.1:5679`）に、開発の `n8n` と同じ手順でオーナー（未作成なら作る）・公開 API のキー・MCP のトークン（`N8N_PROD_TOKEN`。`mcp-prod` が `n8n-prod.env` に書く）を用意し、provision（Data Table・Mautic と Chatwoot の Webhook〈送り先 `http://10.99.0.2:5680/webhook/...`〉・資格情報・ワークフロー。子だけ公開）を行う。SNS のトピックは本番スタックの出力から。SNS 用のキーがその IAM ユーザーのものか、ハートビートのアラームの状態（警告だけ）も見る | `n8n-prod:mautic-api-credentials`（n8n 用の Mautic の API 認証情報）・`n8n-prod:chatwoot-admin-token`・`n8n-prod:aws-key`（`manual-steps.md` の 8.6）／親の公開（R1）とハートビートの有効化 |
| `mcp-prod` | `ops/setup/`（prod だけ） | 本番の MCP の env ファイル 6 つ（`chatwoot-prod`・`mautic-prod`・`mautic-prod-ro`・`strapi-prod`・`n8n-prod`・`posthog-prod`）を `prod.conf` から書く（600）。読み取りだけで確かめる（Chatwoot の `/api/v1/profile`、Mautic の client_credentials、Strapi と n8n の MCP の `tools/list`。strapi-prod に公開・非公開化・削除のツールが出たら失敗） | トークンと API 認証情報の発行（本番の各管理画面。エージェント専用のアカウント。`manual-steps.md` の 8.2） |

## フロントエンド全体（setup/frontend.mjs）

公開サイト（`frontend/verdant-virgo`。Astro）と監視アプリ（`frontend/next-js`）を用意する。**公開サイトの環境変数は、バックエンドのモジュールが状態に置いた値から写す**ので、`setup/setup.mjs` を先に終わらせておく。

```bash
node setup/frontend.mjs --target dev --check   # 何も変えずに、どこまで用意できているかを見る
node setup/frontend.mjs --target dev           # 実行する（止まったら案内に従い、同じコマンドを実行し直す）
node setup/frontend.mjs --target prod          # 段階 apps: 本番のビルド用の .env.production（測定 ID は空。ビルドと配信はしない）
node setup/frontend.mjs --target prod --phase google   # 公開サイトが Route 53 から配信された後: 測定 ID と Search Console の所有権
```

| id | 場所 | 自動でやること | 止まって頼むこと（manual） |
|---|---|---|---|
| `ga4` | `middleware/ga4/setup/` | バックエンドと同じモジュール（開発の環境変数に測定 ID が無いことの確認。prod は ID の形式） | prod だけ: `ga4:property` |
| `verdant-virgo` | `frontend/verdant-virgo/setup/` | **dev**: `.env`（600）を書く（下の表）・`pnpm install`・Lighthouse CI の Chrome の確認・a11y の検査の Chromium（`pnpm exec playwright install chromium`）・受け口の確認（Strapi の公開記事の件数・Chatwoot のウィジェット・Mautic のフォーム・consent-api。止まっていても警告だけ）・dev サーバーの起動（`astro dev --background`。環境変数を書き換えたら `astro dev stop` してから起動し直す）。**prod**: 承認済みの `main` のチェックアウトに `.env.production`（600）を `prod.conf` から書く・そこで `pnpm install`・本番の Strapi（`127.0.0.1:1338`）を読めるかと公開記事の件数（警告だけ）・Search Console の所有権の TXT を DNS で確かめる（prod は段階 `apps` と `google` の 2 回動く。`apps` は測定 ID を空で書いて所有権の確認を飛ばし、`google` で測定 ID を入れて所有権を確かめる） | dev: `verdant-virgo:restart-dev`（前景の `pnpm dev` が動いていて止められない）／prod: `verdant-virgo:prod-values`（本番の値が足りない）・`verdant-virgo:gsc-domain`（ドメインプロパティの所有権） |
| `next-js` | `frontend/next-js/setup/` | バックエンドと同じモジュール（監視アプリ） | `next-js:google-client`・`next-js:start-app`・`next-js:restart-app` |

`ga4`・`next-js` はバックエンドの `setup.mjs` にもある（どちらから実行しても同じ結果になる）。

**公開サイトの環境変数の出どころ**（dev。状態・設定にある値は、ファイルの今の値より優先して書き換える。既定値は空のキーだけ）:

| 環境変数 | 出どころ |
|---|---|
| `SITE_URL` | 設定の `PUBLIC_SITE_URL`（空なら `http://localhost:4321`。`.env.example` の `https://example.com` のままなら書き換える） |
| `STRAPI_API_TOKEN` | 状態の `STRAPI_BUILD_TOKEN`（strapi） |
| `PUBLIC_CHATWOOT_WEBSITE_TOKEN` | 状態の `CHATWOOT_WEBSITE_TOKEN`（chatwoot） |
| `MAUTIC_FORM_ID_CONSULT` | 状態の `MAUTIC_FORM_ID_CONSULT`（mautic） |
| `CONSENT_POLICY_VERSION`・`PUBLIC_CONSENT_COOKIE_DOMAIN` | `backend/consent-api` の環境変数ファイルの `CONSENT_POLICY_VERSION`・`COOKIE_DOMAIN`（同じ値にそろえる決まり） |
| `PUBLIC_POSTHOG_PROJECT_TOKEN`・`PUBLIC_POSTHOG_HOST` | 設定の `SITE_POSTHOG_PROJECT_TOKEN`・`SITE_POSTHOG_HOST`。空なら `backend/strapi-system` の環境変数ファイルの値（Strapi と同じプロジェクトに送る） |
| `PUBLIC_CALCOM_LINK` | 設定の `CALCOM_LINK`（任意） |
| `PUBLIC_GA4_MEASUREMENT_ID` | **書かない**（開発ではタグを出さない。ADR-25。あれば失敗） |

- **`.env.production` は承認済みの `main` のチェックアウト（`SITE_BUILD_CHECKOUT`。空なら `CONTROL_MAIN_CHECKOUT`）にだけ書く。** `astro build` は production モードで、`.env.production` を `.env` より優先して読む（`astro.config.mjs` の `loadEnv` は `NODE_ENV` で読むので、`--mode` では逃がせない）。作業ツリーに置くと `pnpm lh` などの開発のビルドまで本番の値で焼かれるため、作業ツリーと同じ場所は止める。dev の `--check` は作業ツリーにこのファイルがあると警告する。そのチェックアウトの監視アプリの builtin の `lighthouse`・`a11y` も本番の値でビルドされる（同意の前は GA4・PostHog を読み込まないので、計測で本番の数値は汚れない）
- **本番の `STRAPI_URL` は `http://127.0.0.1:1338`**（オンプレの本番の Strapi。ADR-21。`cms.comegin.com` は ADR-21 で ALB から外した）。記事はビルドのときに読んで `dist/` に取り込み、公開サイトは実行時に Strapi を読まない。配信用のビルドは開発の Strapi（localhost の 1338 以外・`comegin-strapi-dev.ngrok.app`）を止める（`src/modules/blog/integration.ts`）。開発で ngrok の Strapi を読むなら `dev.conf` に `SITE_STRAPI_URL=https://comegin-strapi-dev.ngrok.app`
- 計測（`pnpm lh`・`pnpm a11y:ci`）とビルドは実行しない（人が指示したときだけ）。配信は人間が承認して実行する（`cloud/README.md` の 4.14）

## 画面での操作（このスクリプトでは自動にできないもの）

**止まったときの操作は [`manual-steps.md`](manual-steps.md) にまとめてある**（表示の id から引ける早見表・パスワードを忘れたとき・n8n の MCP のトークン・監視アプリの main のチェックアウト・任意の外部サービス・ログイン先の一覧）。以下は要点だけ。

1. **Mautic の API 資格情報**（`mautic` で止まる）: Mautic（http://127.0.0.1:8000）に管理者でログイン → 右上の歯車 → **API Credentials** → **New** → Authorization Protocol **OAuth 2**、Name `comegin-dev`、Redirect URI `http://localhost` → 一覧の **Public Key** と **Secret Key** を `dev.conf` の `MAUTIC_CLIENT_ID`・`MAUTIC_CLIENT_SECRET` に書く。
   CLI の `fos:oauth-server:create-client` は名前と権限（role）を付けられず、role の無いクライアントでは client_credentials が動かないため、画面で作る
2. **常駐プロセスの起動**（`strapi`・`next-js` で止まる）: 別の端末で `pnpm dev` を起動したままにする。スクリプトは常駐プロセスを抱えない（Mautic の PHP サーバーだけは例外で、端末から切り離して起動する）
3. **既に管理者がいる製品のパスワード**: 以前に手で作った管理者がいると、そのパスワードを `dev.conf` に書くよう止まる（スクリプトは既存の管理者を勝手に作り直さない）

## 作られる値

**状態ファイル**（`~/.config/comegin/setup/dev.state.json`、600）。`--show <KEY>` で 1 つずつ見る。✔ は秘密値。

| キー | 作る | 用途 |
|---|---|---|
| `CHATWOOT_ADMIN_PASSWORD`✔・`CHATWOOT_ADMIN_TOKEN`✔・`CHATWOOT_ACCOUNT_ID` | chatwoot | 管理者のログイン／n8n の Webhook の作成 |
| `CHATWOOT_AGENT_USER_ID`・`CHATWOOT_AGENT_TOKEN`✔ | chatwoot | エージェント専用ユーザー（ADR-17）。chatwoot-mcp と監視アプリの突き合わせ |
| `CHATWOOT_INBOX_ID`・`CHATWOOT_WEBSITE_TOKEN` | chatwoot | 公開サイトのチャットウィジェット |
| `MAUTIC_ADMIN_PASSWORD`✔ | mautic | 未インストールから入れたときだけ（ユーザー名は `admin`） |
| `MAUTIC_FORM_ID_CONSULT`・`MAUTIC_SEGMENT_ID_MQL` | mautic | 公開サイト（Astro の環境変数）に写す（`MAUTIC_FORM_ID_SOURCE_DL` は 2026-10-20 にやめた。以前の状態に残っていても使わない） |
| `STRAPI_ADMIN_PASSWORD`✔・`STRAPI_DEV_TOKEN`✔・`STRAPI_BUILD_TOKEN`✔ | strapi | 管理者のログイン／strapi-mcp／Astro のビルド |
| `N8N_OWNER_PASSWORD`✔・`N8N_API_KEY`✔・`N8N_DEV_TOKEN`✔ | n8n | オーナーのログイン／provision／n8n の MCP |

管理者のメールアドレスはすべて `ADMIN_EMAIL`（Chatwoot のエージェント専用ユーザーだけは `+ai-agent` 付き）。

**本番の状態ファイル**（`~/.config/comegin/setup/prod.state.json`、600。`--target prod --show <KEY>`）:

| キー | 作る | 用途 |
|---|---|---|
| `CHATWOOT_ACCOUNT_ID`・`CHATWOOT_AGENT_USER_ID`・`CHATWOOT_INBOX_ID`・`CHATWOOT_WEBSITE_TOKEN` | chatwoot-prod | 受信箱・メンバー。website_token は公開サイトの本番のビルド（verdant-virgo の `.env.production`）が読む |
| `CHATWOOT_FAQ_BOT_ID`・`CHATWOOT_FAQ_BOT_TOKEN`✔・`CHATWOOT_FAQ_BOT_SECRET`✔ | chatwoot-prod | FAQ ボット。トークンと secret は人が Secrets Manager に入れる（`manual-steps.md` の 8.3） |
| `MAUTIC_FORM_ID_CONSULT`・`MAUTIC_SEGMENT_ID_MQL`・`MAUTIC_EMAIL_ID_CONSULT_AUTO_REPLY` | mautic-prod | フォーム consult の ID は公開サイトの本番のビルドが読む |
| `N8N_OWNER_PASSWORD`✔・`N8N_API_KEY`✔・`N8N_PROD_TOKEN`✔ | n8n-prod | 本番の n8n のオーナーのログイン（作ったときだけ）／provision／本番の n8n の MCP（mcp-prod が `n8n-prod.env` に書く。`prod.conf` に同じキーがあればそちらが優先） |
| `DB_INIT_POSTGRES_STACK_CREATED`・`DB_INIT_MYSQL_STACK_CREATED` | cloud（段階 apps） | DB 作成のタスクの成功を確かめた本番スタックの作成時刻（スタックを作り直すと確かめ直す） |

本番の管理者のトークン（`CHATWOOT_ADMIN_TOKEN`）と、Mautic の初期設定用の API 認証情報は、`prod.conf` にだけ置く（状態には写さない）。

**MCP の env ファイル**（`~/.config/comegin/mcp/`、600。`ops/mcp-registry.yaml` が参照する）: 開発は `chatwoot-dev.env`・`mautic-dev.env`・`strapi-dev.env`・`n8n-dev.env`（`umami-dev.env` は ADR-25 で Umami を廃止したので作らない。前に作られたものは自分で消す）。本番は `mcp-prod` が `chatwoot-prod.env`・`mautic-prod.env`・`mautic-prod-ro.env`・`strapi-prod.env`・`n8n-prod.env`・`posthog-prod.env` を `prod.conf` から書く。

**各プロジェクトの環境変数ファイル**: 既存の `dev/init-env.sh` と同じく、**空のキーだけを書く**（暗号化の鍵などを上書きしない）。

## Webhook の送り先と SSRF 対策

Mautic と Chatwoot は、私設アドレスへの Webhook を既定で送らない（SSRF 対策）。n8n の受け口（I-11・I-12）は開発も本番も私設アドレスなので、許可が要る。

| | 開発（このスクリプトが設定する） | 本番（ADR-21。宛先は WireGuard 越しの `10.99.0.2:5680`。人が設定する） |
|---|---|---|
| Mautic | `config/local.php` の `webhook_allowed_private_addresses` に `127.0.0.1`（`MAUTIC_WEBHOOK_TARGET` のホスト）を足す（`dev/allow-webhook-private-addresses.php`。キャッシュも捨てる） | 同じ項目（設定 > Webhook 設定）に **`10.99.0.2` だけ**を入れる。範囲（`10.0.0.0/8` など）では許可しない |
| Mautic の自動停止 | `disable_auto_unpublish` を `true`（`dev/disable-webhook-auto-unpublish.php`）。開発は I-11 が未公開（404）なのが既定なので、失敗で「n8n I-11」が止まらないようにする | **`false` のまま**（失敗が続いた Webhook は止まる）。止まったら n8n の provision を実行し直して公開に戻す（非公開の「n8n I-11」を公開にする） |
| Mautic のキューモード | `queue_mode` を `command_process`（`dev/queue-webhooks.php`）。Webhook をフォームの送信などの要求の中で送らず、キューに積む。送るのは `dev/serve.sh` の 60 秒ごとの `mautic:webhooks:process`（`WEBHOOK_INTERVAL` で変えられる）。要求の中で n8n を待つと、公開サイトのフォームが 10 秒で打ち切られる | 同じ値。`mautic-cron` が `mautic:webhooks:process` を毎分実行する（TA-06 の 3.1） |
| Mautic の CORS（Webhook ではないが同じ `local.php` を書く） | `cors_valid_domains` に公開サイトの開発のオリジン（`http://localhost:4321`・`http://localhost:4322`・`https://comegin-astro-dev.ngrok.app`。`dev.conf` の `MAUTIC_CORS_VALID_DOMAINS` で変えられる）を足す（`dev/allow-cors-domains.php`）。無いとフォームの応答を読めず、画面は「送信できませんでした」になる | 同じ項目（設定 > システム設定 > CORS 設定）に**本番の公開サイトのオリジンだけ**を入れる。「ドメインを制限する」は Yes のまま |
| Chatwoot | `.env` の `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`（`dev/init-env.sh`）。rails と sidekiq を作り直して反映する | 宛先ごとの許可が無く、私設アドレス全体を開ける切り替えしか無い。**本番でも `true` が要る**ので、Chatwoot のタスクのセキュリティグループの出口を、必要な私設アドレス（RDS・ElastiCache と `10.99.0.2:5680`）だけに絞る |

許可が無いと、Mautic は webhook_logs に `Access to private addresses is not allowed.` を、Chatwoot は Sidekiq のログに `has no public ip addresses` を残すだけで、n8n には何も届かない（Chatwoot は再送しない）。

## 秘密値の扱い

- 生成した秘密値は状態ファイルにだけ置き、画面・ログ・例外の文に出さない（`--show` で明示したときだけ表示）
- 子プロセスに秘密値を渡すときは、コマンドライン引数ではなく標準入力か環境変数を使う（`ps` に出さない）。Strapi の管理者は CLI（`admin:create-user`）がパスワードを引数でしか受けないため、管理 API（`/admin/register-admin`）で作る
- 子プロセスの出力は貯めておき、失敗したときだけ最後の 20 行を伏せ字にして表示する

## モジュールを足すとき

1. `<モジュール>/setup/index.mjs` に、`setup/lib/core.mjs` の冒頭に書いた形（`meta`・`check`・`apply`）で書く。見本は `middleware/host-relay/setup/index.mjs`
2. `setup/setup.mjs`（フロントエンドのモジュールなら `setup/frontend.mjs`）の `MODULES` に、依存の順で 1 行足す
3. 新しい設定のキーは `setup.conf.example` に、新しい状態のキーはこの README の「作られる値」に足す

## 既知の未確認（最初の実行で分かる）

各モジュールの API の応答の形は、動いているコンテナの中のソースから確かめたもので、認証が要る呼び出しはまだ実機で通していない。失敗したら、表示された HTTP の状態と理由を添えて知らせる。直してから `--from <id>` で続きから実行する。
