# 設定スクリプトで人が行う操作（画面・端末）

`node setup/setup.mjs --target dev` は、公式の CLI と API でできることだけを自動で行う。
それ以外の操作に当たると、**手順を表示して止まる**（終了コード 3）。この文書は、その操作をまとめたもの。
操作が終わったら、**同じコマンドを実行し直す**。済んだ手順は飛ばして、続きから進む。

**スクリプトが止まらない（確かめない）人の作業もある**（公開サイトのビルドと配信、オンプレの WireGuard・Strapi・n8n の立ち上げの手順そのものなど。SES や SNS の購読のように警告だけで止めないものもある）。全体の順番と一覧は [`setup/00-setup-overview.md`](../setup/00-setup-overview.md)。

パスはリポジトリのルートからの相対。画面の表記は、各製品の開発環境の言語（Mautic・n8n は英語）に合わせてある。
画面の表記は 2026-10-05 に各製品のソース（翻訳ファイル）で確かめた。版が上がって表記が変わっていたら、この文書を直す。

## 0. 早見表

止まったときの表示「画面での操作が必要: …（`<id>`）」の `<id>` で引く。

**監視アプリの「設定の状況」（`/setup-status`）が、この表を承認済み main から読んで、項目の「止まったとき」に行をそのまま出す**（2026-11-09）。列の並び（id・いつ・何を・節）を変えない。1 列目の id は最初の「（」より前に `` `モジュール:id` `` で書き、同じモジュールの続きは `` `build` `` のようにモジュールを省いてよい。カタログ（`setup/status/steps.mjs`）の止まる id がこの表にあることは `node setup/status/verify-steps.mjs` が確かめる。

| 表示の id | いつ止まるか | 何をするか | 節 |
|---|---|---|---|
| `mautic:api-credentials`／`n8n:mautic-api-credentials` | Mautic の API 資格情報が設定に無い | **Mautic の画面で資格情報を作る**（必ず 1 回は要る） | [2](#2-mautic-の-api-資格情報必須) |
| `chatwoot:admin-password` | 以前に手で作った管理者がいる | パスワードを設定に書く／作り直しを許す | [3.1](#31-chatwoot) |
| （mautic の失敗） | Mautic の管理者のパスワードが分からない | 画面の「Forgot your password?」 | [3.2](#32-mautic) |
| `openseo:dataforseo-key` | OpenSEO の health で DataForSEO が ok でない | DataForSEO の Base64 の認証情報を設定に書く | [7.4](#74-openseodataforseo-と-search-console) |
| `openseo:google-oauth-client`（`--target prod` だけ） | Search Console と GA4 用の OAuth クライアントが無い | Google Cloud Console でクライアントを作る | [7.4](#74-openseodataforseo-と-search-console) |
| `openseo:project`（`--target prod` だけ） | OpenSEO に Domain が `comegin.com` のプロジェクトが無い（または 2 つ以上ある） | OpenSEO の画面でプロジェクトの Domain を `comegin.com` にする（エージェントはこれで対象を決める） | [7.4](#74-openseodataforseo-と-search-console) |
| `openseo:gsc-connect`（`--target prod` だけ） | そのプロジェクトで Search Console に接続していない（MCP で確かめる） | OpenSEO の画面で接続する（使わないなら `OPENSEO_SKIP_GSC=yes`） | [7.4](#74-openseodataforseo-と-search-console) |
| `openseo:ga4-connect`（`--target prod` だけ） | そのプロジェクトで GA4 に接続していない（MCP で確かめる） | 2 つの API の有効化・リダイレクト URI の追加・OpenSEO の画面で本番の GA4 プロパティに接続（使わないなら `OPENSEO_SKIP_GA4=yes`） | [7.5](#75-ga4adr-25) |
| （`--phase operate` の `openseo` の警告） | OpenSEO が常駐していない・プロジェクトや接続が欠けた | 止まらない。表示に従って直す | [7.6](#76-openseo-の設定の通し常駐と確かめ方) |
| `ga4:property`（`--target prod` だけ） | GA4 のプロパティ ID・測定 ID が設定に無い | 本番の GA4 プロパティを作って設定し、2 つの値を設定に書く | [7.5](#75-ga4adr-25) |
| （ga4 の失敗）`PUBLIC_GA4_MEASUREMENT_ID` がある | 開発の Astro の環境変数ファイルに測定 ID が書かれている | その行を消して `--from ga4` で再実行（開発ではタグを出さない） | [7.5](#75-ga4adr-25) |
| `strapi:admin-password`／`strapi:admin-login` | 以前に手で作った管理者がいる | パスワードを設定に書く | [3.4](#34-strapi) |
| `n8n:owner-password`／`n8n:owner-login` | 以前に手で作ったオーナーがいる | パスワードを設定に書く | [3.5](#35-n8n) |
| `n8n:mcp-token` | n8n の MCP のトークンが作成済み | 控えを写す／作り直しを許す | [4](#4-n8n-の-mcp-のトークン) |
| `n8n:mcp-managed-by-env` | MCP の設定が環境変数で固定されている | 画面で有効か確かめる | [4](#4-n8n-の-mcp-のトークン) |
| `strapi:start-dev`／`next-js:start-app`／`next-js:restart-app` | 開発サーバーが動いていない／環境変数を書き換えた | 別の端末で起動（し直し）したままにする | [5](#5-常駐させる開発サーバーの起動) |
| （next-js の失敗）`CONTROL_MAIN_CHECKOUT が無い` | 承認済みの `main` のチェックアウトが無い | `git worktree` で作る | [6](#6-監視アプリの承認済みの-main-のチェックアウト) |
| `next-js:google-client` | 監視アプリの Google ログインの OAuth クライアントが無い | **Google Cloud Console で作る**（必須。ADR-23） | [7.2](#72-監視アプリの-google-ログイン必須) |
| `admin-auth:google-client`・`next-js:anthropic-key`（`!` で `yes` を待つ） | admin-auth の Google の資格情報・Anthropic の API キーが無い | 試すときだけ作る。作らないなら `yes` | [7](#7-外部サービスの資格情報) |
| `verdant-virgo:restart-dev` | 公開サイトの環境変数を書き換えたが、dev サーバーを `astro dev stop` で止められない（別の端末の前景の `pnpm dev`） | その端末で Ctrl+C で止めて、`node setup/frontend.mjs --target dev` を実行し直す（`astro dev --background` で起動する） | [5](#5-常駐させる開発サーバーの起動) |
| （verdant-virgo の失敗）`PUBLIC_GA4_MEASUREMENT_ID` がある | 開発の Astro の環境変数ファイルに測定 ID が書かれている | ga4 と同じ。その行を消して `node setup/frontend.mjs --target dev --from verdant-virgo` | [7.5](#75-ga4adr-25) |
| `verdant-virgo:prod-values`（`--target prod`） | 本番の公開サイトのビルドの値が `prod.conf` に足りない（ビルドを行う承認済みの `main` のチェックアウト `SITE_BUILD_CHECKOUT` が無い・作業ツリーと同じときは失敗として止まる） | 表示されたキーを `prod.conf` に書く（雛形は `setup/setup.conf.example` の「公開サイト」） | `setup/README.md` の「フロントエンド全体」 |
| `verdant-virgo:gsc-domain`（`--target prod`） | `comegin.com` に Search Console の所有権の TXT が無い | Search Console にドメインプロパティを登録し、Route 53 に TXT を足す（使わないなら `OPENSEO_SKIP_GSC=yes`） | [7.4](#74-openseodataforseo-と-search-console) |
| `cloud:env`（`--target prod`。段階 `env`） | 道具・AWS の認証・`cloud/samconfig.toml` の必須の値が足りない | 道具を入れる／`aws sso login` など／`samconfig.toml` を雛形から作って値を書く | [cloud 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| `cloud:rollback`／`cloud:leftovers`（段階 `deploy`） | 本番スタックの初回の作成が失敗して戻された／戻されずに残ったリソースがある | スタックを消す／表示されたコマンドで残りを消す | [cloud 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| `cloud:global`／`cloud:cloudfront-params`／`cloud:sam-deploy`（段階 `deploy`） | global・本番のスタックが無い・失敗している／CloudFront の 2 つのパラメータが雛形のまま | `sam deploy --config-env global`／表示された ARN を書く／`sam build` → `sam deploy` | [cloud 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| `cloud:secrets`（段階 `deploy`） | `admin-auth/GOOGLE_CLIENT_SECRET` に値が無い | シェルの履歴に残らない方法で `put-secret-value` | [cloud 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| `cloud:push`（段階 `images`） | 本番スタックのイメージのタグが ECR に無い | 表示されたコマンドでビルドしてプッシュする | [cloud 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| `cloud:db-init`（段階 `apps` の最初） | DB 作成のタスクが、今の本番スタックの作成の後に成功したログが無い | `db-init-postgres`・`db-init-mysql` を RunTask する | [cloud 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| `chatwoot-prod:ecs`（`--target prod`） | `chatwoot-web`・`chatwoot-worker` の DesiredCount（親のパラメータ）が 0 | `db:chatwoot_prepare` の RunTask → `samconfig.toml` に台数を書いて `sam deploy` | [cloud 7.3](../cloud/README.md#73-本番の-chatwootchatwoot-prod) |
| `mautic-prod:ecs-web`／`mautic-prod:ecs-cron`（`--target prod`） | `mautic-web` の DesiredCount が 0（インストールの前）／`mautic-cron` が 1 でない（初期設定の後） | `samconfig.toml` に台数を書いて `sam deploy` | [cloud 7.4](../cloud/README.md#74-本番の-mauticmautic-prod) |
| `n8n-prod:mautic-api-credentials`／`n8n-prod:chatwoot-admin-token`／`n8n-prod:aws-key`（`--target prod`） | n8n 用の Mautic の API 認証情報が無い・ほかの用途と同じ値／Chatwoot の管理者のトークンが無い／SNS 用の IAM のキーが無い・そのユーザーのものでない | Mautic の画面で作る／`CHATWOOT_ADMIN_TOKEN` を書く／キーを発行して書く | [onprem「本番の n8n」](../onprem/README.md#本番の-n8nn8n-prod) |
| `n8n-prod:owner-password`／`n8n-prod:owner-login`／`n8n-prod:mcp-token`（`--target prod`） | 本番の n8n に、スクリプトが作っていないオーナー・MCP のトークンが既にある | 開発の 3.5・4 と同じ（キーは `prod.conf` の `N8N_OWNER_PASSWORD`・`N8N_PROD_TOKEN`・`N8N_MCP_ROTATE`） | [onprem「本番の n8n」](../onprem/README.md#本番の-n8nn8n-prod) |
| `onprem:onprem-bringup`（`--target prod`） | 本番のオンプレ | AWS のデプロイの後、WireGuard → Strapi → n8n の順に人が立ち上げる | [onprem「起動の順番」](../onprem/README.md#起動の順番) |
| `admin-auth:prod-deploy`／`admin-auth:prod-migrate`（`--target prod`） | 本番の admin-auth の discovery が応答しない／運用の Lambda での移行と ALB の登録を申告していない | 段階 `deploy`（`--phase deploy`）を済ませる／`admin-auth-ops` に `migrate`・`register-alb-client` を送り、`ADMIN_AUTH_PROD_READY=yes` を書く | [cloud 7.2](../cloud/README.md#72-本番の-admin-auth) |
| `chatwoot-prod:onboarding`／`chatwoot-prod:faq-bot-secrets`（`--target prod`） | 本番の Chatwoot の管理者・エージェント専用ユーザーのトークンが無い／FAQ ボットのトークンを Secrets Manager に入れたと申告していない | 画面の onboarding とエージェントの招待をしてトークンを書く／表示されたコマンドで Secrets Manager に入れて `FAQ_BOT_SECRETS_STORED=yes` | [cloud 7.3](../cloud/README.md#73-本番の-chatwootchatwoot-prod) |
| `mautic-prod:settings`（`--target prod`） | 本番の Mautic が未インストール・API が無効・画面の設定を申告していない・初期設定用の API 認証情報が無い | インストールして画面で設定し、`MAUTIC_SETUP_CLIENT_*` と `MAUTIC_PROD_SETTINGS_DONE=yes` を書く | [cloud 7.4](../cloud/README.md#74-本番の-mauticmautic-prod) |
| `mcp-prod:prod-values`／`mcp-prod:finish`（`--target prod`） | 本番の MCP のトークン・API 認証情報が `prod.conf` に無い／オンプレの Strapi・n8n に届かない・main のチェックアウトに dist が無い | 本番の各管理画面でエージェント専用のアカウントに発行して書く／dist は main のチェックアウトでパッケージごとにビルドする | [onprem「本番の MCP」](../onprem/README.md#本番の-mcpmcp-prod)・[「MCP サーバの dist」](../onprem/README.md#mcp-サーバの-dist-をビルドするmcp-prodfinish) |
| `next-js-prod:checkout`／`build`／`principal`／`status-principal`／`status-github`／`agent-worktree`／`cycle`／`strapi-tokens`／`deploy-values`／`openai`／`mautic-reader`／`prod-values`／`systemd`／`systemd-dir`／`restart`／`start`（`--target prod`。段階 `operate`） | 監視アプリ（改善ループ）を本番の値で常駐させる前提が足りない（チェックアウト・ビルド・IAM の主体とキー・設定の状況の読み取り専用の主体〈`status-principal`〉と GitHub の参照専用のトークン〈`status-github`〉・**改善の周の設定**。**`agent-worktree`・`cycle`・`strapi-tokens`・`deploy-values` の「無い」は、周のジョブ〈`ops/schedules` の `cycle-*`・`article-cover`・`campaign-asset-upload`〉を 1 本でも `enabled: true` にした後に止まる**〈すべて無効なら警告だけ〉。形の誤り・片方だけ・同じ値は常に止まる: `agent-worktree`＝エージェント専用の作業場が無い・開発のリポジトリや main のチェックアウトと同じ場所／`cycle`＝`CONTROL_CYCLE_ANCHOR` が無い・月曜でない／`strapi-tokens`＝本番の Strapi の読み取りトークンが無い・書き込みトークンが読み取りと同じ／`deploy-values`＝配信の SSO のプロファイル名などが無い／`openai`＝OpenAI の上限・サイズが違う〈キーの無い・形が違うは警告〉／`mautic-reader`＝Mautic の参照用の認証情報が片方だけ・ほかの用途と同じ値〈無いだけなら警告〉〉・`prod.conf` の値・systemd のユニット） | 表示のとおり。どれも人が自分の端末で行う（`agent-worktree` は [6.2](#62-エージェント専用の作業場agent-worktree)、`cycle` は [7.10](#710-改善の周の起点control_cycle_anchor)、`strapi-tokens` は [7.8](#78-本番の-strapi-の-api-トークン2-つ)、`deploy-values` は [cloud 4.14](../cloud/README.md#414-astro-の配信)、`openai` は [7.7](#77-openai-の-api-キーアイキャッチ画像)、`mautic-reader` は [7.9](#79-mautic-の参照専用の-api-認証情報control-plane-用)、`status-principal` は [cloud 4.5.3](../cloud/README.md#453-設定の状況の主体statusreaderpolicyarnを作りキーを発行する1-回だけ)、`status-github` は onprem「設定の状況を有効にする」） | [onprem「監視アプリ（改善ループ）を本番で動かす」](../onprem/README.md#監視アプリ改善ループを本番で動かす)・[「設定の状況を有効にする」](../onprem/README.md#設定の状況を有効にするsetup-status) |
| （`cloud` の `!`。段階 `operate`） | 配信用の主体が無い・IAM ユーザーに古いキーが残っている・`prod.conf` に初期設定用の値が残っている・SES がサンドボックス | 配信用の主体と SES は手順を出して `yes` を待つ。古いキーと `prod.conf` の値は削除の注意で止めない。`setup/00-setup-overview.md` の P15 | [cloud 4.5](../cloud/README.md#45-iam-の管理ポリシーを付けるオンプレの-iam-ユーザーのキーを発行する) |

## 1. 設定ファイルの書き方（全節で共通）

人が書く値は、すべて `~/.config/comegin/setup/dev.conf` に書く（雛形は `setup/setup.conf.example`）。

```bash
mkdir -p ~/.config/comegin/setup && chmod 700 ~/.config/comegin/setup
cp setup/setup.conf.example ~/.config/comegin/setup/dev.conf   # 最初の 1 回だけ
chmod 600 ~/.config/comegin/setup/dev.conf
# エディタで開いて KEY=値 を書く。必須は ADMIN_EMAIL だけ
```

- 秘密値をシェルのコマンドに直接打たない（`echo KEY=… >> dev.conf` は履歴に残る）。エディタで書く
- 設定と状態（スクリプトが作った値）の両方に同じキーがあると、**設定が優先**される
- スクリプトが作ったパスワードは `node setup/setup.mjs --target dev --show <KEY>` で 1 つずつ見る（[9 節](#9-ログイン先の一覧)）

## 2. Mautic の API 資格情報（必須）

n8n（Webhook の作成・I-19 の検索）と mautic-mcp が使う OAuth 2 のクライアント。**Mautic には資格情報を作る API が無く**、CLI（`fos:oauth-server:create-client`）では名前と権限（role）が付かず client_credentials が動かないため、画面で作る。

1. http://127.0.0.1:8000 に管理者でログインする
   - スクリプトがインストールした場合: ユーザー名 `admin`、パスワードは `node setup/setup.mjs --target dev --show MAUTIC_ADMIN_PASSWORD`
   - 以前からある場合: 自分の管理者のアカウント（パスワードが分からなければ [3.2](#32-mautic)）
2. API が無効なら有効にする（スクリプトの案内に「API enabled」の手順が出たときだけ。いまの開発環境は有効）
   - 右上の歯車 → **Configuration** → **API Settings** タブ → **API enabled?** を **Yes** → **Save & Close**
3. 右上の歯車 → **API Credentials**（`/s/credentials`）→ **New**
4. 次のように入れて **Save & Close**

   | 項目 | 値 |
   |---|---|
   | Authorization Protocol | **OAuth 2** |
   | Name | `comegin-dev` |
   | Redirect URI | `http://localhost`（必須の欄だが、client_credentials では使わない） |

   **管理者が作ること。** 作った人の権限（role）がそのままクライアントの権限になる
5. 一覧の **Public Key**（＝クライアント ID）と **Secret Key**（＝クライアントシークレット）を控える。この 2 列はウィンドウの幅が広いときだけ表示される
6. `dev.conf` に書く

   ```
   MAUTIC_CLIENT_ID=<Public Key>
   MAUTIC_CLIENT_SECRET=<Secret Key>
   ```

7. 同じコマンドを実行し直す。続けて mautic がカスタム項目・フォーム・セグメントを作り、n8n と mautic-mcp もこの値を使う

## 3. 既にいる管理者のパスワード

スクリプトは**既存の管理者を勝手に作り直さない**。以前に手で作った管理者（n8n はオーナー）がいて、そのパスワードをスクリプトが知らないときに止まる。
メールアドレスが `ADMIN_EMAIL` と違う場合は、各節の `*_EMAIL` も書く。

### 3.1 Chatwoot

| 状況 | 設定に書く |
|---|---|
| パスワードを知っている | `CHATWOOT_ADMIN_PASSWORD=<今のパスワード>` |
| 知らない／作り直してよい | `CHATWOOT_RESET_ADMIN_PASSWORD=yes`（管理者のパスワードだけを生成した値に変える。アカウント・会話・受信箱は変わらない。新しい値は `--show CHATWOOT_ADMIN_PASSWORD`） |

### 3.2 Mautic

スクリプトが Mautic の管理者のパスワードを使うのは、未インストールからインストールするときだけ。止まるのは [2 節](#2-mautic-の-api-資格情報必須)でログインするときに分からない場合。

1. http://127.0.0.1:8000/s/login の **Forgot your password?** を開き、ユーザー名かメールを入れて **Reset password**
2. 開発環境のメールは MailHog に届く。http://127.0.0.1:8025 で「Mautic password reset」を開き、リンクから新しいパスワードを決める

### 3.3 Umami（ADR-25 で廃止）

2026-10-06 に Umami をやめた（ADR-25。アクセス解析の正本は GA4）。setup は Umami を扱わない。開発環境に残っている Docker のボリューム（`umami_db-data`・`umami_umami-db-data`・`umami-master_umami-db-data`）と、`~/.config/comegin/setup/dev.state.json` の `UMAMI_*`・`~/.config/comegin/mcp/umami-dev.env` は、要らなければ自分で消す（スクリプトは消さない）。

<details><summary>旧版（2026-10-06 まで）</summary>

| 状況 | すること |
|---|---|
| パスワードを知っている | `dev.conf` に `UMAMI_ADMIN_PASSWORD=<今のパスワード>`（ユーザー名は `admin`） |
| 知らない | Umami には API・CLI でパスワードを再設定する手段が無い。開発環境の Umami のデータを作り直してよければ、自分で `cd middleware/umami && docker compose down -v` を実行してから再実行する（2026-10-06 から開発環境の Umami は `middleware/umami` の自作の compose で動く。DB のボリュームは `umami_db-data`）（スクリプトはデータを消さない。初期の管理者 `admin` / `umami` に戻り、スクリプトがパスワードを変える） |

2 要素認証を設定している管理者は、API でログインできないので止まる（解除してから再実行）。

</details>

### 3.4 Strapi

| 状況 | すること |
|---|---|
| パスワードを知っている | `dev.conf` に `STRAPI_ADMIN_PASSWORD=<今のパスワード>`（メールが違えば `STRAPI_ADMIN_EMAIL=`） |
| 知らない | 開発サーバーを止め、**自分の端末で** `cd backend/strapi-system && pnpm strapi admin:reset-user-password -e <メール> -p <新しいパスワード>`（大文字・小文字・数字を含む 8 文字以上）。この CLI はパスワードを引数でしか受けないので、シェルの履歴から消しておく。そのあと `dev.conf` に書いて、`pnpm dev` を起動し直してから再実行 |

### 3.5 n8n

| 状況 | すること |
|---|---|
| パスワードを知っている | `dev.conf` に `N8N_OWNER_PASSWORD=<今のパスワード>`（メールが違えば `N8N_OWNER_EMAIL=`） |
| 知らない | 開発の n8n は SMTP を設定していないので、メールでの再設定はできない。最後の手段は `cd middleware/n8n && docker compose exec n8n n8n user-management:reset`（**オーナー以外のユーザーを消し、オーナーを未設定の状態に戻す**。ワークフローと資格情報はオーナーに集めて残る。出典: コンテナの `dist/commands/user-management/reset.js`、[公式](https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line)）。再実行すると、スクリプトがオーナーと API キーを作り直す |

## 4. n8n の MCP のトークン

n8n の MCP（`http://127.0.0.1:5678/mcp-server/http`）のアクセストークンは、**作ったときに 1 回しか表示されない**（画面の注意書き: "Make sure to copy your access token, you won't be able to see it again"）。すでに作ってあると、スクリプトは値を読めずに止まる。

| 状況 | `dev.conf` に書く |
|---|---|
| 作ったときの値を控えてある（Claude Code の n8n の MCP の接続設定に入れた値など） | `N8N_DEV_TOKEN=<その値>` |
| 控えが無い／作り直してよい | `N8N_MCP_ROTATE=true`。**今のトークンを使っている MCP クライアントは切れる**。新しい値は `~/.config/comegin/mcp/n8n-dev.env` に入るので、Claude Code など手元のクライアントの設定をそれに合わせる。作り直したら `N8N_MCP_ROTATE=` を空に戻す |

`n8n:mcp-managed-by-env` で止まったとき: n8n の compose の環境変数で MCP の設定が固定されているため、API で有効にできない。n8n の画面（http://127.0.0.1:5678）の **Settings** → **Instance-level MCP** を開き、**Enable MCP access** が押せる状態（無効）なら、環境変数の指定を外すか有効にしてから再実行する。

## 5. 常駐させる開発サーバーの起動

スクリプトは常駐プロセスを抱えない（Mautic の PHP サーバーだけは例外で、端末から切り離して起動する。ログは `~/.config/comegin/setup/mautic-serve.log`）。
次の 2 つは、**別の端末で起動したまま**にしてから再実行する。

| id | 起動 | 準備ができた目安 |
|---|---|---|
| `strapi:start-dev` | `cd backend/strapi-system && pnpm dev` | http://127.0.0.1:1337/_health が 204（数十秒） |
| `next-js:start-app`／`next-js:restart-app` | `cd frontend/next-js && pnpm dev`（restart は動いているものを Ctrl+C で止めてから） | 端末に `Ready`。初回は画面のコンパイルに時間がかかる。環境変数ファイル（Google の資格情報・`BETTER_AUTH_URL`）は起動したときに読まれる |

スクリプトが環境変数ファイルを書き換えたときは「起動中のサーバーは書き換え前の値で動いている」と警告が出る。その場合は起動し直す。

## 6. 監視アプリの「承認済みの main のチェックアウト」

監視アプリは、エージェント定義（`.claude/agents/`）と `ops/`（定期実行・MCP の登録表）を、作業ツリーではなく**承認済みの `main` の別のチェックアウト**から読む（ADR-18。作業ツリーで書き換えた未承認の定義を実行に効かせないため）。その場所を `CONTROL_MAIN_CHECKOUT` に書く。

```bash
cd ~/ComeGin/systematization-of-the-business-foundation
git fetch origin

# まだ無ければ作る。ローカルの main ではなく origin/main から（ローカルの main は遅れていることがある。読むだけなので detached でよい）
git worktree add --detach ~/ComeGin/main-checkout origin/main

# 既にあるなら origin/main に合わせる（以後、PR が main にマージされるたびにこれで更新する）
git -C ~/ComeGin/main-checkout checkout --detach origin/main
```

**「CONTROL_MAIN_CHECKOUT に ops/mcp-registry.yaml が無い」で止まったとき**は、チェックアウトが古いコミットを指している（2026-10-07 の例: ローカルの `main` が `Initial commit` のままで、そこから作っていた）。`git -C ~/ComeGin/main-checkout log --oneline -1` で確かめ、上の `checkout --detach origin/main` で合わせてから `--from next-js` で続ける。

**注意**: このチェックアウトに入るのは `origin/main` にマージ済みの内容だけ。作業中のブランチの変更（例: ADR-25 の `analytics-reporter` の GA4 化と、登録表から `umami`・`umami-prod` を消したこと）は、PR が main にマージされるまで監視アプリの実行に効かない（ADR-18 の意図どおり）。

`dev.conf` に `CONTROL_MAIN_CHECKOUT=/home/<ユーザー>/ComeGin/main-checkout`（絶対パス）を書いて再実行する。
作業ツリーと同じ場所を指すと、スクリプトが警告を出す（分離が働かない）。**コミットしていない変更はこのチェックアウトに入らない**。エージェントが書く場所は、これとも開発のリポジトリとも別の 3 本目のチェックアウトにする（6.2）。

### 6.1 MCP サーバの dist をビルドする（`mcp-prod:finish`）

本番の MCP だけの手順なので、2026-11-02 に [`onprem/README.md` の「MCP サーバの dist をビルドする」](../onprem/README.md#mcp-サーバの-dist-をビルドするmcp-prodfinish) に移した。

### 6.2 エージェント専用の作業場（`agent-worktree`）

改善の周（2026-11-09）では、エージェントの書き込みを、開発しているリポジトリとは**別の 3 本目のチェックアウト**に集める（`CONTROL_WORKTREE`）。いまの `CONTROL_WORKTREE` の既定は開発のリポジトリそのもので、夜中に作られた差分（記事・コード・観測・提案）が人の開発中の変更と混ざる。3 つの場所は**互いに別**にする。

| 場所 | 役割 | 設定 |
|---|---|---|
| 開発のリポジトリ（作業ツリー） | 人が普段開発する。`SETUP_WORKTREE`・スクリプトを実行する場所 | — |
| 承認済みの main のチェックアウト | 実行条件（`ops/`・`.claude/agents/`）を読む。ビルドして配信する元 | `CONTROL_MAIN_CHECKOUT`（6 節） |
| **エージェント専用の作業場** | エージェントの cwd。観測・提案・下書き・差分の書き先。周の始まり（`cycle-open`）に、未コミットの変更が無ければ `origin/main` に合わせられる | `CONTROL_WORKTREE`（本番は `prod.conf`） |

```bash
cd ~/ComeGin/systematization-of-the-business-foundation
git fetch origin

# まだ無ければ作る（人が行う。setup は git を書き換えない）。ローカルの main ではなく origin/main から。読み書きするので --detach でよい（コミットは人が、origin/main から切ったブランチで行う）
git worktree add --detach ~/ComeGin/agent-worktree origin/main
```

- `prod.conf` に `CONTROL_WORKTREE=/home/<ユーザー>/ComeGin/agent-worktree`（絶対パス）を書く。**周のジョブを 1 本でも有効にした後に無いと `next-js-prod:agent-worktree` で止まる**（既定の開発のリポジトリには書かせない。すべて無効なら警告だけ）。開発（`--target dev`）では、`CONTROL_WORKTREE` が開発のリポジトリ自身でもよい（定期実行は動かさない。`dev.conf` に書かなければそのまま）
- 3 つのうち、同じ場所を指しているものがあると、スクリプトが本番では**止め**（`next-js-prod:checkout`＝main のチェックアウトが作業ツリーと同じ／`next-js-prod:agent-worktree`＝作業場が main または開発のリポジトリと同じ）、開発では警告する
- 作業場の中身は人が確かめてコミットする: 画面に出るコミットのコマンドは、この作業場で `origin/main` から `<Issue番号>-feature-<名前>` のブランチを切り、項目に結びついたファイルだけを `git add` する形になる
- 周の始まりに `origin/main` へ合わせるのは、変更がエージェントの書く場所（`docs/audits/`・`docs/proposals/`・`docs/cycles/`）の未追跡のファイルだけのとき。ほかの変更（コードの差分など）が残っていれば合わせず、画面で知らせる（人の作業を消さない。`CONTROL_WORKTREE_SYNC=false` で合わせない）

## 7. 外部サービスの資格情報

7.2（監視アプリの Google ログイン）は必須。7.1・7.3 は無くても開発環境は動くので、試すときだけ作る。どれも `dev.conf` に書いて再実行する。**7.7〜7.10 は本番（`prod.conf`）だけ**の、改善の周の設定（OpenAI のキー・本番の Strapi のトークン・Mautic の参照用の認証情報・周の起点）。

Google の OAuth クライアントは、Google Workspace（comegin.com）の管理者が Google Cloud Console で作る。最初の 1 回だけ、**Google Auth Platform** → **Branding** で、未設定なら **Get started**（アプリ名・サポートのメールを入れ、**Audience** は **Internal**＝組織内のアカウントだけ）。

**承認済みのリダイレクト URI は、そのアプリの `BETTER_AUTH_URL`（ブラウザで開く URL）＋ `/api/auth/callback/google`。** ngrok で開くアプリは ngrok の URL にする。URL が 1 文字でも違うと、Google が `redirect_uri_mismatch` で止める。

### 7.1 admin-auth の Google ログイン（任意。`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`）

1. **Google Auth Platform** → **Clients** → **Create Client**
   - Application type: **Web application**、Name: `comegin-admin-auth-dev`
   - **Authorized redirect URIs** → **Add URI**: `<admin-auth の BETTER_AUTH_URL>/api/auth/callback/google`（いまの開発は ngrok で `https://comegin-admin-auth-dev.ngrok.app/api/auth/callback/google`。`localhost` で開くなら `http://localhost:3103/api/auth/callback/google`。本番は `https://auth.comegin.com/api/auth/callback/google` で、別のクライアントにする）
2. **Create** の後に表示されるクライアント ID とシークレットを `dev.conf` の `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` に書く
3. ログインできるのは許可リストにあるメールだけ。スクリプトは許可リストに `ADMIN_EMAIL` を入れる（`backend/admin-auth/README.md` の 3 段の検査）

### 7.2 監視アプリの Google ログイン（必須）

監視アプリのログインは Google だけ（ADR-23。メールとパスワードのログインは無い）。`next-js:google-client` で止まったら、次を行う。

1. **Google Auth Platform** → **Clients** → **Create Client**
   - Application type: **Web application**、Name: `comegin-control-dev`
   - **Authorized redirect URIs** → **Add URI**: `<監視アプリの BETTER_AUTH_URL>/api/auth/callback/google`（いまの開発は ngrok で `https://comegin-next-js-dev.ngrok.app/api/auth/callback/google`。止まったときの表示にも、そのときの URL で出る）
2. **Create** の後に表示されるクライアント ID とシークレットを `dev.conf` に書く

   ```
   CONTROL_GOOGLE_CLIENT_ID=<クライアント ID>
   CONTROL_GOOGLE_CLIENT_SECRET=<シークレット>
   ```

   7.1 と同じクライアントを使ってもよい。その場合は、そのクライアントの Authorized redirect URIs に監視アプリの URI も足し、`CONTROL_GOOGLE_*` は空のままにする（スクリプトが `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` を使う）

   **本番（`next-js-prod`）は、同じクライアントに `http://127.0.0.1:3200/api/auth/callback/google` も足す。** 本番の監視アプリは `http://127.0.0.1:3200` で開き（`prod.conf` の `CONTROL_PUBLIC_URL` が空なら、この値になる）、ngrok で外に出さない（`onprem/README.md` の「開く（監視アプリ）」）
3. 同じコマンドを実行し直す。スクリプトが監視アプリの環境変数ファイルに書き、`next-js:restart-app` で止まったら監視アプリを起動し直す（環境変数は起動したときに読まれる）。最後にスクリプトが、Google の認可 URL の `hd`（`comegin.com`）とリダイレクト URI を確かめる
4. ブラウザで `<BETTER_AUTH_URL>/login` を開き、**Google でログイン**。通るのは次の 3 つを満たすアカウントだけ（どれかが欠けると `/login` に戻り、「ログインできませんでした」と出る。理由の種類は `pnpm dev` の端末に `[auth] login refused: …` で出る）
   - `comegin.com` の Google Workspace のアカウント（ID トークンの `hd`）
   - メールが確認済み（`email_verified`）
   - メールが許可リスト `CONTROL_ADMIN_EMAILS` にある（既定は `ADMIN_EMAIL`。増やすときは `dev.conf` に `CONTROL_ADMIN_EMAILS=a@comegin.com,b@comegin.com` と書いて再実行し、監視アプリを起動し直す）

監視アプリには MFA が無い。**Google Workspace の 2 段階認証を組織で必須にする**（ADR-23 の帰結）。

### 7.3 監視アプリのエージェント（任意。`ANTHROPIC_API_KEY`）

Claude Console（https://platform.claude.com）で API キーを作り、`dev.conf` に書く。空のままでも監視アプリは起動するが、エージェントの実行は skipped として記録される。

### 7.4 OpenSEO（DataForSEO と Search Console）

OpenSEO（`middleware/open-seo-main`、`http://127.0.0.1:3001`。認証なし・ループバックだけ）は、調査とランク追跡に DataForSEO（費用が出る）を、実績の取得に Google Search Console と GA4 を使う。スクリプトは環境変数ファイルを作って起動し、`/api/health` の `checks` を見て、足りないものだけを案内する。

**`--target dev` では Google（OAuth クライアント・Search Console・GA4）の手順を飛ばす**（2026-10-06）。開発の時点では公開サイトが AWS に展開されておらず、Search Console にも GA4 にもデータが無いため。dev で案内するのは DataForSEO だけで、check も Google の接続を求めない。OpenSEO はオンプレのローカルに 1 つだけで、開発と本番のエージェントが同じものを使うので、**公開サイトが Route 53 から配信された後に `node setup/setup.mjs --target prod --phase google` で Google の手順を行う**（値は `~/.config/comegin/setup/prod.conf` に書く）。dev の実行は Google の OAuth クライアントを OpenSEO の環境変数ファイルに書かない（prod で設定したクライアントを `dev.conf` の `GOOGLE_CLIENT_ID`〈admin-auth 用〉で上書きしないため）。

**prod の `ga4`・`openseo` は段階 `google` で動く**（2026-10-27。`setup/README.md` の「本番の段階」）。AWS に展開しても、公開サイト（Astro）が Route 53 から配信されるまでは Search Console にも GA4 にもデータが無いため、`--phase` を付けない実行（`env`〜`apps`）には入らない。**`openseo` は段階 `operate` でも動き、常駐しているかを警告だけで確かめる**（2026-11-04。7.6）。

**接続は申告ではなく、スクリプトが確かめる**（2026-11-04）。OpenSEO 自身の MCP（`127.0.0.1:3001/mcp`）の、費用の出ないツール 3 本（`list_projects`・`get_search_console_performance`・`get_google_analytics_measurement_health`）を呼ぶ。以前の `OPENSEO_GSC_CONNECTED=yes`・`OPENSEO_GA4_CONNECTED=yes` は要らない（書いてあっても使わない）。止まる順は `google-oauth-client` → `project` → `gsc-connect` → `ga4-connect` で、1 つ済ませるたびに同じコマンドを実行し直す。

| 表示の id | すること |
|---|---|
| `openseo:dataforseo-key` | https://app.dataforseo.com/api-access で認証情報を取り寄せ、「Base64」と書かれた長いほうの値（`login:password` を base64 にしたもの。ダッシュボードの API キーではない）を `DATAFORSEO_API_KEY=` に書く |
| `openseo:google-oauth-client`（prod） | Google Cloud Console で「Google Search Console API」を有効にし、種類 Web application の OAuth クライアントを作る。リダイレクト URI は `http://localhost:3001/api/gsc/oauth/callback`（完全一致。末尾にスラッシュを付けない）。値は `prod.conf` の `OPENSEO_GOOGLE_CLIENT_ID=`・`OPENSEO_GOOGLE_CLIENT_SECRET=` に書く（admin-auth と同じクライアントを使うなら `prod.conf` の `GOOGLE_CLIENT_ID=`・`GOOGLE_CLIENT_SECRET=` に書き、クライアントに上のリダイレクト URI も足す） |
| `openseo:project`（prod） | ブラウザで `http://localhost:3001`（127.0.0.1 ではなく localhost）を開く。初回に自動でできる **Default** プロジェクトを使うなら、左上のプロジェクト名の横の歯車（Project settings）→ **General** の **Domain** に `comegin.com` を入れて保存する（`https://` と `www.` は付けない）。新しく作るなら、プロジェクトの一覧の **New project** で Name（例 `ComeGin`）と Domain `comegin.com` を入れる。**Domain が `comegin.com` のプロジェクトは 1 つだけにする**（エージェントの `seo-auditor`・`analytics-reporter` は `list_projects` でこのドメインを探し、0 件でも 2 件以上でも止まる。2026-11-04 の夜の観測は、Default の Domain が開発の ngrok の URL のままで、GSC も GA4 も読めなかった）。市場は日本・日本語（`market:2392/ja`）。ドメインは設定の `GSC_DOMAIN` で変えられる（既定 `comegin.com`） |
| `openseo:gsc-connect`（prod） | 上のプロジェクトを選び、Project settings → **Integrations** の Search Console の「Connect with Google」で同意し、ドメインプロパティ `sc-domain:comegin.com` を選ぶ。**接続はプロジェクトごと**（別のプロジェクトで接続しても、エージェントは読めない）。済んだら同じコマンドを実行し直す（スクリプトが `get_search_console_performance` で確かめる。選んだのが `sc-domain:comegin.com` でなければ警告） |

**接続しても「No properties available」と出るとき**は、接続した Google アカウントに Search Console の確認済みのプロパティが無い（OpenSEO の不具合ではない）。設計（ADR-09）どおり**ドメインプロパティ `sc-domain:comegin.com`** を登録する: Search Console で「プロパティを追加 → ドメイン」に `comegin.com` → 表示された TXT レコード（`google-site-verification=…`）を Route 53 のホストゾーン `comegin.com` に追加 → 確認 → OpenSEO で接続し直す。公開サイトが無くても登録できる。

~~Google Analytics（GA4）は接続しない~~ → **ADR-25（2026-10-06）で GA4 を接続する**（アクセス解析の正本を GA4 にした。手順は 7.5）。

**サイトマップの送信**（公開サイトの配信の後。設定スクリプトは確かめない）: Search Console のドメインプロパティ `comegin.com` の **インデックス作成 → サイトマップ** で、`https://comegin.com/sitemap-index.xml` を送信する（`@astrojs/sitemap` が出すインデックス。中身の `sitemap-0.xml` を個別に送らない。ページが増えて `sitemap-1.xml` ができてもインデックスが拾う）。ドメインプロパティなので、入力欄には完全な URL を書く。`SITE_URL` を `www` 付きに変えたら送り直す。送信後は「成功しました」と、検出された URL の数が `sitemap-0.xml` の `<loc>` の件数と合うことを確かめる（2026-11-02 時点で 18 件。404 などの `noindex` のページは入っていない）。2026-11-02 に送信し、成功を確かめた。同じ URL は `robots.txt` の `Sitemap:` にも書いてある（`frontend/verdant-virgo/src/pages/robots.txt.ts`。`SITE_URL` から作る。`noindex` のページは `Disallow` にしない。クローラーが読めないと `noindex` に気づけないため）。

Search Console を使わないと決めたなら `prod.conf` に `OPENSEO_SKIP_GSC=yes` を書く。詳しい手順はモジュール（`middleware/open-seo-main/dev/setup/index.mjs`）の案内にも出る。

### 7.5 GA4（ADR-25）

アクセス解析（流入・ページ・参照元）の正本は GA4（ADR-25）。エージェント（`analytics-reporter`）は OpenSEO の MCP（`get_google_analytics_*`）で読む。**プロパティは本番の 1 つだけ**で、開発環境の公開サイトには測定 ID を設定しない（開発ではタグを出さない）。構成の正本は `middleware/ga4/README.md`。

**`--target dev` では、本番のプロパティの作成（`ga4:property`）と OpenSEO への接続（`openseo:ga4-connect`）を飛ばす**（2026-10-06。7.4 と同じ理由）。dev の `ga4` が確かめるのは「開発の Astro に測定 ID が無いこと」だけ。下の 2 つは公開サイトが Route 53 から配信された後に `--target prod --phase google` で行い、値は `prod.conf` に書く。それまで（段階 `apps`）は公開サイトの `.env.production` に測定 ID を空で書く（タグを出さない）。配信の後に `setup.mjs --target prod --phase google` と `frontend.mjs --target prod --phase google` を実行し、ビルドし直す（2026-10-27）。

| 表示の id | すること |
|---|---|
| `ga4:property`（prod） | Google アナリティクスで本番のプロパティを作る（タイムゾーン `Asia/Tokyo`・通貨 `JPY`・データ保持 14 か月・Google シグナル オフ・ユーザー提供データの収集 オフ・広告のリンクなし。詳しくは `middleware/ga4/README.md`）→ Web ストリーム（`https://comegin.com`）を作る → プロパティ ID（数字）を `GA4_PROPERTY_ID=`、測定 ID（`G-` で始まる）を `GA4_MEASUREMENT_ID=` に書く |
| `openseo:ga4-connect`（prod） | Google Cloud Console で（Search Console と同じ OAuth クライアントのプロジェクトで）「Google Analytics Admin API」と「Google Analytics Data API」を有効にする → OAuth クライアントのリダイレクト URI に `http://localhost:3001/api/ga4/oauth/callback` を足す（GSC の URI は残す）→ `http://localhost:3001` の、Domain が `comegin.com` のプロジェクト（7.4 の `openseo:project`）の Project settings → **Integrations**（またはダッシュボード）の GA4 の「Connect with Google」→ 読み取り専用の権限に同意し、**本番のプロパティ**（`561857847`）を選ぶ → 同じコマンドを実行し直す（スクリプトが `get_google_analytics_measurement_health` で確かめ、プロパティが `GA4_PROPERTY_ID` と違えば警告し、`--check` は失敗にする）。GA4 を使わないなら `OPENSEO_SKIP_GA4=yes` |

開発の Astro（`frontend/verdant-virgo`）の環境変数ファイルに `PUBLIC_GA4_MEASUREMENT_ID` があると、`ga4` は**失敗として止まる**（画面の操作ではなく設定の誤りのため）。その行を消して `--from ga4` で再実行する（本番のビルドだけが測定 ID を持つ）。

**接続の後に「Couldn't load properties」と出るとき**（2026-11-02 に起きた）は、OpenSEO のログ（`docker logs open-seo-main-open-seo-1`）の `ga4.property_discovery_failed` の `status` を見る。`403` なら Analytics Admin API が、OAuth クライアントの Google Cloud プロジェクト（クライアント ID の先頭の数字がプロジェクト番号）で有効になっていない。同意画面で Analytics のチェックを外した場合も 403 になるが、それは OpenSEO の DB の `account` テーブル（`provider_id` が `google-analytics`）の `scope` に `analytics.readonly` が無いことで見分けられる。API を有効にしたら数分待ってページを読み直す（接続し直さなくてよい）。Google アカウントにプロパティの権限が無い場合は 403 にならず、一覧が空になる。

OAuth の同意画面が「テスト中」のままだと、更新トークンの期限が短く、接続が切れることがある（出典 `middleware/open-seo-main/docs/SELF_HOSTING_GOOGLE_ANALYTICS.md`）。切れたら画面で接続し直す。

### 7.6 OpenSEO の設定の通し（常駐と確かめ方）

7.4・7.5 は止まったときの id ごとの操作。ここは、OpenSEO を最初から使える状態にして常駐させるまでの順番と、確かめ方をまとめる（2026-11-04 に追加）。

#### 何のためにあるか・なぜ常駐させるか

OpenSEO は**オンプレの道具**（TA-07 の 3.7。正本のデータは持たない）。改善ループのエージェントが、夜の定期実行（JST 0〜8 時。`ops/README.md`）の中で MCP の `openseo` で呼ぶ。止まっていると、その夜の観測が `fetch.outcome` 付きの空の E-12 になり、提案の根拠が欠ける。

| エージェント | 定期実行（`ops/schedules/`） | OpenSEO で読む・するもの | 費用 |
|---|---|---|---|
| `seo-auditor` | `daily-observe-seo`（毎日 04:00）・`weekly-observe-serp-audit`（月曜 02:00） | Search Console の実績・URL 検査・保存済みの順位計測とサイト監査 | 出ない |
| `analytics-reporter` | `daily-observe-analytics`（毎日 04:00） | GA4（本番のプロパティ。5 本だけ） | 出ない |
| `keyword-researcher` | `weekly-keyword-research`（月曜 02:30） | キーワード調査（DataForSEO） | **出る**（1 回の見積もり 2,000 クレジットまで） |
| `knowledge-scout` | — | 競合ドメインの市場データ（DataForSEO） | **出る**（同じ上限） |

どのツールを使えるかは、エージェント定義（`.claude/agents/*.md`）の `tools` の許可リストで決まる（`openseo` の登録には `ACCESS_LEVEL` が無い。`ops/README.md` の MCP の表）。

#### 構成

| 項目 | 値 |
|---|---|
| 置き場 | `middleware/open-seo-main`（上流の取り込み。`compose.yaml` は変えない。独自の追加は `dev/setup/` だけ） |
| 待ち受け | `127.0.0.1:3001`（画面と MCP の `/mcp`）。`AUTH_MODE=local_noauth` で認証が無いので、**トンネルを張らない・ngrok で出さない** |
| 開発と本番 | **1 つを共用**（開発用・本番用に分けない）。Google に接続するのは本番のプロパティだけ |
| イメージ | `ghcr.io/every-app/open-seo:0.1.8`（ダイジェストで固定。モジュールの `PINNED_IMAGE`。版を上げるときはこの定数を変えて `--only openseo` を実行し直す） |
| データ | Docker のボリューム `open-seo-main_open_seo_data`。プロジェクト・保存したキーワード・Search Console と GA4 の OAuth のトークン（`BETTER_AUTH_SECRET` で暗号化）が入る |
| 環境変数ファイル | `middleware/open-seo-main` の環境変数ファイル（権限 600。スクリプトが設定〈`<target>.conf`〉から書く。手で書き換えない） |
| 常駐のしかた | systemd のユニット `comegin-openseo`（雛形 `onprem/systemd/comegin-openseo.service`。`Requires=docker.service` だけで WireGuard に依存しない。置くのは人）が起動時に `docker compose up -d`。落ちたときの回復は上流の `compose.yaml` の `restart: unless-stopped`（onprem「常駐させる（OpenSEO）」。2026-11-04 にユニットを足した） |

#### 順番

1. **起動と DataForSEO**（開発の一式の中でも、単独でもよい）

   ```bash
   node setup/setup.mjs --target dev --only openseo
   ```

   環境変数ファイルを作り（`BETTER_AUTH_SECRET` を生成。既にあれば変えない）、`docker compose up -d` で上げ、`/api/health` を確かめる。`openseo:dataforseo-key` で止まったら 7.4 の表のとおり `DATAFORSEO_API_KEY` を書いて再実行する。

2. **Google（公開サイトが Route 53 から配信された後。段階 `google`）**

   ```bash
   node setup/setup.mjs --target prod --phase google --only openseo
   ```

   止まる順に 1 つずつ済ませ、そのたびに同じコマンドを実行し直す。

   | 順 | 止まる id | すること | 節 |
   |---|---|---|---|
   | 1 | `openseo:google-oauth-client` | Google Cloud で 3 つの API を有効にし、OAuth クライアント（リダイレクト URI 2 つ）を作って `prod.conf` に書く | 7.4・7.5 |
   | 2 | `openseo:project` | Domain が `comegin.com` のプロジェクトを 1 つだけにする | 7.4 |
   | 3 | `openseo:gsc-connect` | そのプロジェクトで Search Console（`sc-domain:comegin.com`）に接続する | 7.4 |
   | 4 | `openseo:ga4-connect` | そのプロジェクトで GA4（本番のプロパティ `561857847`）に接続する | 7.5 |

   最後まで通ると「終わった」と出る。Search Console のドメインプロパティの登録（`verdant-virgo:gsc-domain`）と GA4 のプロパティの作成（`ga4:property`）は、別のモジュール（`setup.mjs` の `ga4`・`frontend.mjs` の `verdant-virgo`）が案内する（`setup/00-setup-overview.md` の P13）。

3. **ユニットを置く（人が行う）**

   `onprem/systemd/comegin-openseo.service` の `User` と `WorkingDirectory`（作業ツリーの `middleware/open-seo-main` の絶対パス。手順 1 で環境変数ファイルを書いた場所）を書き換えてから置く。

   ```bash
   sudo install -m 644 onprem/systemd/comegin-openseo.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now comegin-openseo.service
   ```

4. **常駐の確認（段階 `operate`）**

   ```bash
   node setup/setup.mjs --target prod --phase operate --only openseo
   ```

   足りないものがあれば手順を出して `yes` を待つ（2026-11-10 から。それまでは警告だけ）。コンテナが止まっていれば `docker compose up -d` で上げ直す（環境変数ファイルは変えない）。それ以外の欠け（ユニットが無い・enabled でない・active でない・`WorkingDirectory` が違う、再起動の設定、プロジェクト・接続）は表示に従って直す。`--phase operate` を丸ごと実行したときも、同じ確認が入る（`setup/00-setup-overview.md` の P14）。

#### スクリプトが確かめること

| 確かめること | 段階 | 使うもの |
|---|---|---|
| 応答する・DB が使える・`authMode` が `local_noauth`・DataForSEO が設定済み | dev・google・operate | `GET /api/health`（無料） |
| Domain が `comegin.com` のプロジェクトがちょうど 1 つ | google・operate | MCP の `list_projects`（無料） |
| Search Console に接続し、プロパティが `sc-domain:comegin.com` | google・operate | MCP の `get_search_console_performance`（無料。Google の API を 1 行だけ読む） |
| GA4 に接続し、プロパティが `GA4_PROPERTY_ID` と同じ | google・operate | MCP の `get_google_analytics_measurement_health`（無料。GA4 の Admin API を読む） |
| コンテナが running・再起動の設定が `unless-stopped` か `always` | operate | `docker compose ps`・`docker inspect` |
| ユニット `comegin-openseo` があり、enabled・active で、`WorkingDirectory` が作業ツリーの `middleware/open-seo-main` | operate | `systemctl show`（`LoadState`・`UnitFileState`・`ActiveState`・`WorkingDirectory`） |

スクリプトが呼ぶ MCP のツールは、この 3 本だけに限ってある（モジュールの `FREE_TOOLS`）。DataForSEO を呼ぶツールは呼ばない。設定の状況の画面（監視アプリの `/setup-status`）も、1 時間に 1 回まで同じ確認をする。

手で確かめるとき（無料のツールだけ）:

```bash
curl -s http://127.0.0.1:3001/api/health
curl -s -X POST http://127.0.0.1:3001/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'
docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' open-seo-main-open-seo-1
```

#### 困ったとき

| 症状 | 原因 | 対処 |
|---|---|---|
| 夜の観測（`docs/audits/gsc/`・`analytics/`）の `fetch.note` に「`domain` が `comegin.com` のプロジェクトが 0 件」 | プロジェクトの Domain が `comegin.com` でない（2026-11-04 に起きた。Default の Domain が開発の ngrok の URL だった） | 7.4 の `openseo:project` |
| マシンを再起動したら OpenSEO が上がらない | ユニット `comegin-openseo` が無い・enabled でない（ユニットが無いと、`docker compose stop` で止めたままのコンテナは上がらない） | 手順 3 でユニットを置く。`sudo systemctl enable --now comegin-openseo` |
| `systemctl status comegin-openseo` が failed | `WorkingDirectory` が無いパス・環境変数ファイルが無い・Docker が上がっていない | `journalctl -u comegin-openseo -n 50`。パスを直したら `sudo systemctl daemon-reload && sudo systemctl restart comegin-openseo` |
| ユニットは active なのに応答しない | `docker compose stop` で止めた（ユニットは active のまま残る） | `sudo systemctl restart comegin-openseo`。作業で止めるときは `systemctl stop` / `start` を使う |
| 再起動の後、Google の接続が全部切れている | ユニットの `WorkingDirectory` が別のチェックアウトで、そこの環境変数ファイルの `BETTER_AUTH_SECRET` が違う（ファイルが無ければ、上の failed になる） | `WorkingDirectory` を作業ツリーの `middleware/open-seo-main` にして置き直す。`--check` の operate が食い違いを警告する |
| 接続していたのに `gsc-connect`・`ga4-connect` で止まる | OAuth の同意画面が「テスト中」で更新トークンが切れた・Google 側で権限を外した | 画面で接続し直す（7.5 の最後） |
| すべての接続が一度に切れた | 環境変数ファイルの `BETTER_AUTH_SECRET` が変わった（保存済みのトークンを復号できない） | **変えない**。変わってしまったら、手順 2 の 3・4 で接続し直す |
| プロジェクトも接続も消えた | ボリューム `open-seo-main_open_seo_data` を消した（`docker compose down -v` など） | **`-v` を付けない**。消えたら手順 2 の 2〜4 をやり直す（保存したキーワード・順位計測の履歴は戻らない） |
| `--force-recreate` の後に応答しない | 初回はコンテナの中でビルドしてから待ち受ける（1〜2 分） | 待つ。5 分たっても応答しなければ `docker compose logs open-seo` |

### 7.7 OpenAI の API キー（アイキャッチ画像）

記事のアイキャッチ画像を作る builtin `article-cover` が使う。**任意**（無ければ `article-cover` は `skipped` で、画像が作られないだけ）。費用が出るので、上限を決めてから発行する。

1. OpenAI の Platform（https://platform.openai.com）の API keys で、**このプロジェクト専用のプロジェクトキー**を作る（名前は `comegin-control-prod` など）。使う API は Images API だけなので、プロジェクトの権限は **Images のみ**に絞り、月の使用上限（Usage limits）を決める
2. `prod.conf` に `OPENAI_API_KEY=sk-…` を書く（エディタで。画面・履歴に出さない。chmod 600）。モデルとサイズは既定（`gpt-image-2.5-sunburst`・`1536x1024`）でよく、変えるときだけ `CONTROL_OPENAI_IMAGE_MODEL`・`CONTROL_OPENAI_IMAGE_SIZE` を書く
3. **1 回の実行で作る枚数は `CONTROL_COVER_MAX_PER_RUN`（既定 3。1〜10）が上限**で、費用の上限でもある。上げるときは `ops/schedules/article-cover.yaml` の `timeout_sec`（いまは 1200）も同じ PR で上げる（`ops/README.md`）
4. 動かすには、次の 7.8 の**書き込み用**の Strapi のトークンも要る（アップロードに使う。無ければ費用を出す前に `skipped`）
5. キーは監視アプリのサーバー側だけが持ち、エージェントの子プロセスには渡らない

`next-js-prod` は、枚数の上限（1〜10）・サイズの形を確かめる（キーが無い・`sk-` で始まらないだけなら止まらず、警告）。

### 7.8 本番の Strapi の API トークン（2 つ）

オンプレの本番の Strapi（`http://127.0.0.1:1338`。`onprem/strapi`）の管理画面（Settings → API Tokens → Create new API Token）で、**用途の違うトークンを 2 つ**作る。MCP 用の Admin トークン（`STRAPI_PROD_TOKEN`）とは別にする。

| トークン | `prod.conf` のキー | 権限（Custom） | 使う処理 |
|---|---|---|---|
| 読み取り | `CONTROL_STRAPI_READ_TOKEN`（**周のジョブを 1 本でも有効にするときに必須。それまでは無くても止めない**） | **Article・Category の `find`・`findOne` だけ**（下書きも読める権限にする。公開済みの記事の一覧・記事の状態の確認に使う。配信用のビルドの `STRAPI_API_TOKEN` にもなる） | `published-article-check`・`cycle-collect` |
| 書き込み | `CONTROL_STRAPI_WRITE_TOKEN`（任意） | **アップロード（Upload の `upload`）と Article の `update` だけ。公開の権限は付けない**（`publish` が無い。記事の公開は R2 が管理画面で行う）。Article の `create`・`delete` も付けない | `article-cover`・`campaign-asset-upload` |

- **書き込みトークンが公開できないことを、開発の Strapi で確かめる**（spec 5.7）。開発の Strapi（`127.0.0.1:1337`）に同じ権限のトークンを作り、下書きの記事に `PUT /api/articles/<documentId>` で `{"data":{"publishedAt":"2026-01-01T00:00:00.000Z"}}` を送って、公開されない（403 か、`publishedAt` が変わらない）ことを見る。**権限に `publish` を付けていなくても、更新で `publishedAt` を書けてしまわないか**を、開発の Strapi の実際の挙動で確かめる。**公開できてしまうなら書き込みトークンを使わず**、アップロード済みのファイルを人が記事に結ぶ運用にする（`article-cover` は、記事の更新が 403 のとき、アップロードまでにして `cover-pending:<documentId>:<fileId>` を残し、人が結ぶ手順を画面に出す）
- キャンペーンの配布物（Agent Plugins の zip）をアップロードするため、Strapi の許可するメディアの種類に `application/zip` を足した（`backend/strapi-system/config/plugins.ts`）。**本番の Strapi を再デプロイ（再起動）して初めて効く**（`onprem/README.md` の Strapi の節）
- 有効期限は無期限か、切れる前に作り直す日を決める。`prod.conf` に書く（エディタで。画面・履歴に出さない）。トークンはエージェントに渡らない
- URL は既定 `http://127.0.0.1:1338`（`CONTROL_STRAPI_URL`）。開発の Strapi（`:1337`）を指すとスクリプトが止める

読み取りトークンが無いときは、周のジョブ（`cycle-*`・`article-cover`・`campaign-asset-upload`）が 1 本でも `enabled: true` のときだけ `next-js-prod:strapi-tokens` で止まる（すべて無効なら警告。有効にする前に書く）。書き込みが読み取り（か MCP のトークン）と同じ値・書き込みだけがある、のときは常に止まる。書き込みトークンが無いだけなら警告（`article-cover`・`campaign-asset-upload` が `skipped`）。

### 7.9 Mautic の参照専用の API 認証情報（control-plane 用）

`cycle-collect` が、キャンペーンの項目の中身（メールとキャンペーンの状態・セグメントの件数）と、公開＝送信の開始を確かめるのに使う。**任意**（無ければ campaign の項目は中身を埋めず、理由を出す。ほかの項目は動く）。

1. 本番の Mautic の管理画面（`https://mkt.comegin.com`）の 設定 > API 認証情報（OAuth 2）で、`mautic-prod-ro` と同じ画面・同じ手順（`onprem/README.md` の「本番の MCP」の表）で、**control-plane 用の認証情報を別に**発行する（名前は `comegin-prod-control` など）。**上流の権限は発行したユーザーのロールで決まる**（`mautic-prod-ro` と同じく、管理者が作ると権限は管理者になる）。参照専用ロールのユーザーで発行できるならそうする。control-plane の読み取りは GET だけ（コードで限る。`backend/control-plane/src/integrations/mautic.ts`）。`mautic-prod-ro`（`analytics-reporter` 用。`MAUTIC_RO_CLIENT_*`）・エージェント用（`MAUTIC_CLIENT_*`）・初期設定用（`MAUTIC_SETUP_CLIENT_*`）・n8n 用（`N8N_MAUTIC_CLIENT_*`）とは**別の認証情報**にする（片方を失効しても、もう片方を止めないため。同じ値ならスクリプトが止める）
2. `prod.conf` に `CONTROL_MAUTIC_CLIENT_ID`・`CONTROL_MAUTIC_CLIENT_SECRET` を書く（エディタで。画面・履歴に出さない）。URL（`CONTROL_MAUTIC_URL`）は空なら `MAUTIC_BASE_URL`、それも無ければ `https://mkt.comegin.com`
3. 3 つは**全部書くか、全部書かないか**（片方だけだと監視アプリが起動時に例外にする）。セグメントの件数は統計の表の件数だけを読み、個々のコンタクトは読まない。認証情報はエージェントに渡らない

### 7.10 改善の周の起点（`CONTROL_CYCLE_ANCHOR`）

改善ループの周は 14 日で、その**起点の日付**を `prod.conf` の `CONTROL_CYCLE_ANCHOR` に `YYYY-MM-DD` で書く（周の ID は `C-<起点の日付>`、周の何日目かは 0〜13）。

- **必ず月曜**にする（JST。`cycle-open` が月曜 00:00 に起動し、周の 0 日目に周を開くため。月曜でないと、周のジョブが無効でもスクリプトが止める。値が無いだけなら、周のジョブを 1 本でも有効にした後に止まる）。例: 2026-11-16（月）
- 決め方: 定期実行を有効にし始める週の月曜か、その次の月曜（周の途中から始めない）。**2 週間ごとに周が替わる**ので、いつの周が奇数・偶数かはこの日で決まる（`cycle-campaign` は周の 8 日目の火曜に動く）
- 後から変えない（変えると周の ID と日が変わり、E-15 の周と項目がずれる）。やり直すなら、周が閉じた後の月曜に決め直す
- 無いと、`cycle-open`・`cycle-collect`・`cycle-close`・`published-article-check` は `skipped`（理由に変数名だけが出る）

## 8. 本番（`--target prod`）

設定は `~/.config/comegin/setup/prod.conf`（雛形は同じ `setup/setup.conf.example`）。**本番で止まったときの操作は、2026-11-02 にクラウドとオンプレの手順書へ移した**（置き場所の決まり: 全体の設定スクリプトと開発環境は `setup/`、クラウドは `cloud/`、オンプレは `onprem/`。`setup/00-setup-overview.md` の冒頭）。GA4・OpenSEO（段階 `google`）は、開発と共通の 7.4・7.5 のまま。

| 以前の節 | 移した先 |
|---|---|
| 8.1 本番の admin-auth | [`cloud/README.md` の 7.2](../cloud/README.md#72-本番の-admin-auth) |
| 8.2 本番の MCP（`mcp-prod`） | [`onprem/README.md` の「本番の MCP」](../onprem/README.md#本番の-mcpmcp-prod) |
| 8.3 本番の Chatwoot（`chatwoot-prod`） | [`cloud/README.md` の 7.3](../cloud/README.md#73-本番の-chatwootchatwoot-prod) |
| 8.4 本番の Mautic（`mautic-prod`） | [`cloud/README.md` の 7.4](../cloud/README.md#74-本番の-mauticmautic-prod) |
| 8.5 AWS のデプロイ（`cloud`） | [`cloud/README.md` の 7.1](../cloud/README.md#71-aws-のデプロイcloud) |
| 8.6 本番の n8n（`n8n-prod`） | [`onprem/README.md` の「本番の n8n」](../onprem/README.md#本番の-n8nn8n-prod) |
| 6.1 MCP サーバの dist をビルドする | [`onprem/README.md` の「MCP サーバの dist をビルドする」](../onprem/README.md#mcp-サーバの-dist-をビルドするmcp-prodfinish) |
| （新設）監視アプリの本番（`next-js-prod`。段階 `operate`） | [`onprem/README.md` の「監視アプリ（改善ループ）を本番で動かす」](../onprem/README.md#監視アプリ改善ループを本番で動かす) |

## 9. ログイン先の一覧

スクリプトが作った管理者のパスワードは `node setup/setup.mjs --target dev --show <KEY>` で見る（画面に出るので、人のいない場所で）。

| 製品 | URL | ユーザー | パスワード |
|---|---|---|---|
| Chatwoot | http://127.0.0.1:3100 | `ADMIN_EMAIL` | `--show CHATWOOT_ADMIN_PASSWORD` |
| Mautic | http://127.0.0.1:8000/s/login | `admin` | `--show MAUTIC_ADMIN_PASSWORD`（スクリプトがインストールした場合だけ） |
| Strapi | http://127.0.0.1:1337/admin | `ADMIN_EMAIL` | `--show STRAPI_ADMIN_PASSWORD`（スクリプトが作った場合だけ） |
| n8n | http://127.0.0.1:5678 | `ADMIN_EMAIL` | `--show N8N_OWNER_PASSWORD`（スクリプトが作った場合だけ） |
| 監視アプリ | `<BETTER_AUTH_URL>/login`（いまの開発は https://comegin-next-js-dev.ngrok.app/login。本番の常駐は http://127.0.0.1:3200/login） | Google（`CONTROL_ADMIN_EMAILS` のアカウント） | なし（Google でログイン。7.2） |
| MailHog（開発のメール） | http://127.0.0.1:8025 | なし | なし |

手で作った管理者のパスワードを `dev.conf` に書いた場合は、そちらを使う（状態には入らない）。
