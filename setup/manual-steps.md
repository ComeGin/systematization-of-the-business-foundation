# 設定スクリプトで人が行う操作（画面・端末）

`node setup/setup.mjs --target dev` は、公式の CLI と API でできることだけを自動で行う。
それ以外の操作に当たると、**手順を表示して止まる**（終了コード 3）。この文書は、その操作をまとめたもの。
操作が終わったら、**同じコマンドを実行し直す**。済んだ手順は飛ばして、続きから進む。

パスはリポジトリのルートからの相対。画面の表記は、各製品の開発環境の言語（Mautic・n8n は英語）に合わせてある。
画面の表記は 2026-10-05 に各製品のソース（翻訳ファイル）で確かめた。版が上がって表記が変わっていたら、この文書を直す。

## 0. 早見表

止まったときの表示「画面での操作が必要: …（`<id>`）」の `<id>` で引く。

| 表示の id | いつ止まるか | 何をするか | 節 |
|---|---|---|---|
| `mautic:api-credentials`／`n8n:mautic-api-credentials` | Mautic の API 資格情報が設定に無い | **Mautic の画面で資格情報を作る**（必ず 1 回は要る） | [2](#2-mautic-の-api-資格情報必須) |
| `chatwoot:admin-password` | 以前に手で作った管理者がいる | パスワードを設定に書く／作り直しを許す | [3.1](#31-chatwoot) |
| （mautic の失敗） | Mautic の管理者のパスワードが分からない | 画面の「Forgot your password?」 | [3.2](#32-mautic) |
| `openseo:dataforseo-key` | OpenSEO の health で DataForSEO が ok でない | DataForSEO の Base64 の認証情報を設定に書く | [7.4](#74-openseodataforseo-と-search-console) |
| `openseo:google-oauth-client`／`openseo:gsc-connect`（`--target prod` だけ） | Search Console と GA4 用の OAuth クライアントが無い／接続を申告していない | Google Cloud Console でクライアントを作る／OpenSEO の画面で接続する（使わないなら `OPENSEO_SKIP_GSC=yes`） | [7.4](#74-openseodataforseo-と-search-console) |
| `openseo:ga4-connect`（`--target prod` だけ） | GA4 の接続を申告していない | 2 つの API の有効化・リダイレクト URI の追加・OpenSEO の画面で本番の GA4 プロパティに接続（使わないなら `OPENSEO_SKIP_GA4=yes`） | [7.5](#75-ga4adr-25) |
| `ga4:property`（`--target prod` だけ） | GA4 のプロパティ ID・測定 ID が設定に無い | 本番の GA4 プロパティを作って設定し、2 つの値を設定に書く | [7.5](#75-ga4adr-25) |
| （ga4 の失敗）`PUBLIC_GA4_MEASUREMENT_ID` がある | 開発の Astro の環境変数ファイルに測定 ID が書かれている | その行を消して `--from ga4` で再実行（開発ではタグを出さない） | [7.5](#75-ga4adr-25) |
| `strapi:admin-password`／`strapi:admin-login` | 以前に手で作った管理者がいる | パスワードを設定に書く | [3.4](#34-strapi) |
| `n8n:owner-password`／`n8n:owner-login` | 以前に手で作ったオーナーがいる | パスワードを設定に書く | [3.5](#35-n8n) |
| `n8n:mcp-token` | n8n の MCP のトークンが作成済み | 控えを写す／作り直しを許す | [4](#4-n8n-の-mcp-のトークン) |
| `n8n:mcp-managed-by-env` | MCP の設定が環境変数で固定されている | 画面で有効か確かめる | [4](#4-n8n-の-mcp-のトークン) |
| `strapi:start-dev`／`next-js:start-app`／`next-js:restart-app` | 開発サーバーが動いていない／環境変数を書き換えた | 別の端末で起動（し直し）したままにする | [5](#5-常駐させる開発サーバーの起動) |
| （next-js の失敗）`CONTROL_MAIN_CHECKOUT が無い` | 承認済みの `main` のチェックアウトが無い | `git worktree` で作る | [6](#6-監視アプリの承認済みの-main-のチェックアウト) |
| `next-js:google-client` | 監視アプリの Google ログインの OAuth クライアントが無い | **Google Cloud Console で作る**（必須。ADR-23） | [7.2](#72-監視アプリの-google-ログイン必須) |
| （警告だけ） | admin-auth の Google の資格情報・Anthropic の API キーが無い | 試すときだけ作る | [7](#7-外部サービスの資格情報) |
| `verdant-virgo:restart-dev` | 公開サイトの環境変数を書き換えたが、dev サーバーを `astro dev stop` で止められない（別の端末の前景の `pnpm dev`） | その端末で Ctrl+C で止めて、`node setup/frontend.mjs --target dev` を実行し直す（`astro dev --background` で起動する） | [5](#5-常駐させる開発サーバーの起動) |
| （verdant-virgo の失敗）`PUBLIC_GA4_MEASUREMENT_ID` がある | 開発の Astro の環境変数ファイルに測定 ID が書かれている | ga4 と同じ。その行を消して `node setup/frontend.mjs --target dev --from verdant-virgo` | [7.5](#75-ga4adr-25) |
| `verdant-virgo:prod-values`（`--target prod`） | 本番の公開サイトのビルドの値が `prod.conf` に足りない（ビルドを行う承認済みの `main` のチェックアウト `SITE_BUILD_CHECKOUT` が無い・作業ツリーと同じときは失敗として止まる） | 表示されたキーを `prod.conf` に書く（雛形は `setup/setup.conf.example` の「公開サイト」） | `setup/README.md` の「フロントエンド全体」 |
| `verdant-virgo:gsc-domain`（`--target prod`） | `comegin.com` に Search Console の所有権の TXT が無い | Search Console にドメインプロパティを登録し、Route 53 に TXT を足す（使わないなら `OPENSEO_SKIP_GSC=yes`） | [7.4](#74-openseodataforseo-と-search-console) |
| `cloud:env`（`--target prod`。段階 `env`） | 道具・AWS の認証・`cloud/samconfig.toml` の必須の値が足りない | 道具を入れる／`aws sso login` など／`samconfig.toml` を雛形から作って値を書く | [8.5](#85-aws-のデプロイcloud) |
| `cloud:global`／`cloud:cloudfront-params`／`cloud:sam-deploy`（段階 `deploy`） | global・本番のスタックが無い・失敗している／CloudFront の 2 つのパラメータが雛形のまま | `sam deploy --config-env global`／表示された ARN を書く／`sam build` → `sam deploy` | [8.5](#85-aws-のデプロイcloud) |
| `cloud:secrets`（段階 `deploy`） | `admin-auth/GOOGLE_CLIENT_SECRET` に値が無い | シェルの履歴に残らない方法で `put-secret-value` | [8.5](#85-aws-のデプロイcloud) |
| `cloud:push`（段階 `images`） | 本番スタックのイメージのタグが ECR に無い | 表示されたコマンドでビルドしてプッシュする | [8.5](#85-aws-のデプロイcloud) |
| `onprem:onprem-bringup`（`--target prod`） | 本番のオンプレ | AWS のデプロイの後 | [8](#8-本番--target-prod) |
| `admin-auth:prod-deploy`／`admin-auth:prod-migrate`（`--target prod`） | 本番の admin-auth の discovery が応答しない／運用の Lambda での移行と ALB の登録を申告していない | 段階 `deploy`（`--phase deploy`）を済ませる／`admin-auth-ops` に `migrate`・`register-alb-client` を送り、`ADMIN_AUTH_PROD_READY=yes` を書く | [8.1](#81-本番の-admin-auth) |
| `chatwoot-prod:onboarding`／`chatwoot-prod:faq-bot-secrets`（`--target prod`） | 本番の Chatwoot の管理者・エージェント専用ユーザーのトークンが無い／FAQ ボットのトークンを Secrets Manager に入れたと申告していない | 画面の onboarding とエージェントの招待をしてトークンを書く／表示されたコマンドで Secrets Manager に入れて `FAQ_BOT_SECRETS_STORED=yes` | [8.3](#83-本番の-chatwootchatwoot-prod) |
| `mautic-prod:settings`（`--target prod`） | 本番の Mautic が未インストール・API が無効・画面の設定を申告していない・初期設定用の API 認証情報が無い | インストールして画面で設定し、`MAUTIC_SETUP_CLIENT_*` と `MAUTIC_PROD_SETTINGS_DONE=yes` を書く | [8.4](#84-本番の-mauticmautic-prod) |
| `mcp-prod:prod-values`／`mcp-prod:finish`（`--target prod`） | 本番の MCP のトークン・API 認証情報が `prod.conf` に無い／オンプレの Strapi・n8n に届かない・main のチェックアウトに dist が無い | 本番の各管理画面でエージェント専用のアカウントに発行して書く | [8.2](#82-本番の-mcpmcp-prod) |

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
作業ツリーと同じ場所を指すと、スクリプトが警告を出す（分離が働かない）。**コミットしていない変更はこのチェックアウトに入らない**。

## 7. 外部サービスの資格情報

7.2（監視アプリの Google ログイン）は必須。7.1・7.3 は無くても開発環境は動くので、試すときだけ作る。どれも `dev.conf` に書いて再実行する。

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

**prod の `ga4`・`openseo` は段階 `google` だけで動く**（2026-10-27。`setup/README.md` の「本番の段階」）。AWS に展開しても、公開サイト（Astro）が Route 53 から配信されるまでは Search Console にも GA4 にもデータが無いため、`--phase` を付けない実行（`env`〜`apps`）には入らない。

| 表示の id | すること |
|---|---|
| `openseo:dataforseo-key` | https://app.dataforseo.com/api-access で認証情報を取り寄せ、「Base64」と書かれた長いほうの値（`login:password` を base64 にしたもの。ダッシュボードの API キーではない）を `DATAFORSEO_API_KEY=` に書く |
| `openseo:google-oauth-client`（prod） | Google Cloud Console で「Google Search Console API」を有効にし、種類 Web application の OAuth クライアントを作る。リダイレクト URI は `http://localhost:3001/api/gsc/oauth/callback`（完全一致。末尾にスラッシュを付けない）。値は `prod.conf` の `OPENSEO_GOOGLE_CLIENT_ID=`・`OPENSEO_GOOGLE_CLIENT_SECRET=` に書く（admin-auth と同じクライアントを使うなら `prod.conf` の `GOOGLE_CLIENT_ID=`・`GOOGLE_CLIENT_SECRET=` に書き、クライアントに上のリダイレクト URI も足す） |
| `openseo:gsc-connect`（prod） | ブラウザで `http://localhost:3001`（127.0.0.1 ではなく localhost）を開き、Integrations の「Connect with Google」で同意し、プロパティを選ぶ。済んだら `prod.conf` に `OPENSEO_GSC_CONNECTED=yes` を書く（接続の有無は OpenSEO の DB の中にあり、スクリプトからは確かめられないため申告制） |

**接続しても「No properties available」と出るとき**は、接続した Google アカウントに Search Console の確認済みのプロパティが無い（OpenSEO の不具合ではない）。設計（ADR-09）どおり**ドメインプロパティ `sc-domain:comegin.com`** を登録する: Search Console で「プロパティを追加 → ドメイン」に `comegin.com` → 表示された TXT レコード（`google-site-verification=…`）を Route 53 のホストゾーン `comegin.com` に追加 → 確認 → OpenSEO で接続し直す。公開サイトが無くても登録できる。

~~Google Analytics（GA4）は接続しない~~ → **ADR-25（2026-10-06）で GA4 を接続する**（アクセス解析の正本を GA4 にした。手順は 7.5）。

Search Console を使わないと決めたなら `prod.conf` に `OPENSEO_SKIP_GSC=yes` を書く。詳しい手順はモジュール（`middleware/open-seo-main/dev/setup/index.mjs`）の案内にも出る。

### 7.5 GA4（ADR-25）

アクセス解析（流入・ページ・参照元）の正本は GA4（ADR-25）。エージェント（`analytics-reporter`）は OpenSEO の MCP（`get_google_analytics_*`）で読む。**プロパティは本番の 1 つだけ**で、開発環境の公開サイトには測定 ID を設定しない（開発ではタグを出さない）。構成の正本は `middleware/ga4/README.md`。

**`--target dev` では、本番のプロパティの作成（`ga4:property`）と OpenSEO への接続（`openseo:ga4-connect`）を飛ばす**（2026-10-06。7.4 と同じ理由）。dev の `ga4` が確かめるのは「開発の Astro に測定 ID が無いこと」だけ。下の 2 つは公開サイトが Route 53 から配信された後に `--target prod --phase google` で行い、値は `prod.conf` に書く。それまで（段階 `apps`）は公開サイトの `.env.production` に測定 ID を空で書く（タグを出さない）。配信の後に `setup.mjs --target prod --phase google` と `frontend.mjs --target prod --phase google` を実行し、ビルドし直す（2026-10-27）。

| 表示の id | すること |
|---|---|
| `ga4:property`（prod） | Google アナリティクスで本番のプロパティを作る（タイムゾーン `Asia/Tokyo`・通貨 `JPY`・データ保持 14 か月・Google シグナル オフ・ユーザー提供データの収集 オフ・広告のリンクなし。詳しくは `middleware/ga4/README.md`）→ Web ストリーム（`https://comegin.com`）を作る → プロパティ ID（数字）を `GA4_PROPERTY_ID=`、測定 ID（`G-` で始まる）を `GA4_MEASUREMENT_ID=` に書く |
| `openseo:ga4-connect`（prod） | Google Cloud Console で（Search Console と同じ OAuth クライアントのプロジェクトで）「Google Analytics Admin API」と「Google Analytics Data API」を有効にする → OAuth クライアントのリダイレクト URI に `http://localhost:3001/api/ga4/oauth/callback` を足す（GSC の URI は残す）→ `http://localhost:3001` のプロジェクトの設定（Analytics）で「Connect with Google」→ 読み取り専用の権限に同意し、**本番のプロパティ**を選ぶ → `OPENSEO_GA4_CONNECTED=yes` を書く。GA4 を使わないなら `OPENSEO_SKIP_GA4=yes` |

開発の Astro（`frontend/verdant-virgo`）の環境変数ファイルに `PUBLIC_GA4_MEASUREMENT_ID` があると、`ga4` は**失敗として止まる**（画面の操作ではなく設定の誤りのため）。その行を消して `--from ga4` で再実行する（本番のビルドだけが測定 ID を持つ）。

OAuth の同意画面が「テスト中」のままだと、更新トークンの期限が短く、接続が切れることがある（出典 `middleware/open-seo-main/docs/SELF_HOSTING_GOOGLE_ANALYTICS.md`）。切れたら画面で接続し直す。

## 8. 本番（`--target prod`）

設定は `~/.config/comegin/setup/prod.conf`（雛形は同じ `setup/setup.conf.example`）。本番でスクリプトが行うのは、外部の値の形式の確認（GA4）・OpenSEO・admin-auth の確認・オンプレの確認・本番の Chatwoot と Mautic の API でできる初期設定・本番の MCP の env ファイルまで。画面でしかできないことと AWS への書き込みは、案内して止まる。`ga4`・`openseo` は prod でも動き、**Google の手順（`ga4:property`・`openseo:google-oauth-client`・`openseo:gsc-connect`・`openseo:ga4-connect`）は prod だけで出る**（7.4・7.5。AWS に展開して公開サイトが動いてから）。`onprem` は、AWS のデプロイ（`cloud/README.md`）の後に WireGuard → Strapi → n8n の順で人が立ち上げる手順を表示する。手順の正本は `onprem/README.md` と `onprem/wireguard/README.md`。

### 8.1 本番の admin-auth

`admin-auth` は、本番の discovery（`https://auth.comegin.com/.well-known/openid-configuration`。ほかのホストなら `prod.conf` の `AUTH_HOST`）を読んで確かめるだけで、AWS には書き込まない。DB の移行と ALB のクライアント登録は、表示された手順のとおり、人が自分の端末で運用の Lambda（`admin-auth-ops`）に `{"action":"migrate"}` と `{"action":"register-alb-client"}` を送る（`cloud/README.md` の 4.19）。管理画面に Google でログインできたら `ADMIN_AUTH_PROD_READY=yes` を書く（移行の有無は DB の中にあり、外から読み取りだけでは確かめられないため申告制）。

### 8.2 本番の MCP（`mcp-prod`）

`ops/mcp-registry.yaml` の本番の登録 6 つの env ファイル（`~/.config/comegin/mcp/<名前>` の env ファイル、600）を `prod.conf` から書く。**Chatwoot・Strapi・n8n・PostHog はエージェント専用のアカウントで発行する**（人間の管理者のトークンを使わない。ADR-17。操作の主体と権限を分けるため）。

**Mautic は例外**: Mautic の API 認証情報は、だれのものでも上流の権限は管理者になる（client_credentials は管理者が作ったときだけ付き、ロールは作った人のものが付く。2026-10-27 に上流の ApiBundle の ClientController で確認）。エージェント用（`mcp-prod`）と analytics-reporter 用（`mcp-prod-ro`）の違いは、MCP サーバの ACCESS_LEVEL（登録表）とエージェント定義の tools の許可リストだけで、Mautic 側では絞れない。認証情報を 2 つに分けるのは、片方を失効・入れ替えしても、もう片方を止めないため。

| `prod.conf` のキー | 発行するところ | 注意 |
|---|---|---|
| `CHATWOOT_AGENT_TOKEN`・`CHATWOOT_ACCOUNT_ID` | 本番の Chatwoot で、エージェント専用のユーザー（担当者の権限）を作ってログインし、プロフィール設定のアクセストークン | 担当者（agent）の権限でないと失敗にする（`chatwoot-prod` と同じ）。管理者のトークン（`CHATWOOT_ADMIN_TOKEN`）と同じ値も失敗にする |
| `MAUTIC_CLIENT_ID`・`MAUTIC_CLIENT_SECRET` | 本番の Mautic の 設定 > API 認証情報（OAuth 2。**管理者がログインして作る**。名前は `comegin-prod-mcp` など）。2 節と同じ手順 | 上流の権限は管理者。初期設定用（`MAUTIC_SETUP_CLIENT_*`）と同じ値は失敗にする |
| `MAUTIC_RO_CLIENT_ID`・`MAUTIC_RO_CLIENT_SECRET` | 同じ画面で、もう 1 つ作る（`mautic-prod-ro`。analytics-reporter 専用。名前は `comegin-prod-mcp-ro` など） | 上流の権限は管理者（読み取りだけに絞るのは ACCESS_LEVEL の `read_only`）。`mautic-prod` と同じ値は失敗にする |
| `STRAPI_PROD_TOKEN` | オンプレの本番の Strapi（`127.0.0.1:1338`）の管理画面で、MCP 用の Admin トークン（**下書きまで**。公開・非公開化・削除の権限を与えない） | `tools/list` に `publish_`・`unpublish_`・`delete_` が出たら失敗にする |
| `N8N_PROD_TOKEN` | オンプレの本番の n8n（`127.0.0.1:5679`）の 設定 > MCP のアクセストークン | n8n のトークンでは `publish_workflow`・`execute_workflow` を絞れない。これらを tools に含むエージェント定義は control-plane が起動しない（警告も出る） |
| `POSTHOG_PROD_API_KEY`・`POSTHOG_PROD_PROJECT_ID` | PostHog の個人 API キー（「MCP Server」のプリセットで、本番のプロジェクトの読み取りだけ）とプロジェクトの数値 ID | `phx_` で始まる個人 API キー（プロジェクトのトークン `phc_` ではない） |

確かめるのはデータの読み取りだけ（Chatwoot の `/api/v1/profile`、Mautic の client_credentials と連絡先 1 件、Strapi と n8n の MCP の `tools/list`）。`--check` でも、認証のための Mautic のトークンの発行と MCP のセッションの作成・終了は行う。env ファイルの中身が `prod.conf` と違えば `--check` が知らせる（apply で書き直す）。n8n の MCP のトークンでは公開・実行のツールを絞れないので、それらを tools に含むエージェント定義は control-plane が起動しない（`backend/control-plane/src/runner/agent.ts`）。`chatwoot-prod`・`mautic-prod*` は承認済みの main のチェックアウト（`CONTROL_MAIN_CHECKOUT`）の `dist` で動くので、そこで `pnpm install && pnpm build` が済んでいないか、chatwoot-mcp がアンダースコアのヘッダーで送る古い版（2026-10-26 より前）だと案内が出る（main を最新にしてビルドし直す。6 節）。

### 8.3 本番の Chatwoot（`chatwoot-prod`）

開発の `chatwoot` と同じ API の手順を、本番（`https://chat.comegin.com`）に向けて行う。本番は `rails runner` を使わないので、最初の 2 人は画面で作る。

1. `cloud/README.md` の 4.10 で `db:chatwoot_prepare` を済ませ、chatwoot-web・worker を起動しておく（4.11）
2. `https://chat.comegin.com` を開き（admin-auth の Google ログインの内側）、onboarding で最初の管理者とアカウントを作る。管理者のプロフィール設定のアクセストークンを `CHATWOOT_ADMIN_TOKEN=`、URL の `/app/accounts/<数字>/` を `CHATWOOT_ACCOUNT_ID=` に書く
3. 設定 → エージェント で、エージェント専用ユーザー（担当者の権限）を招待し、招待メールからパスワードを決めてログインする。そのユーザーのトークンを `CHATWOOT_AGENT_TOKEN=` に書く（`mcp-prod` と共用。ADR-17）
4. 親スタックの出力 `FaqBotFunctionUrl` の末尾に `webhook` を付けた URL を `FAQ_BOT_WEBHOOK_URL=`、本番の公開サイトの URL を `PUBLIC_SITE_URL=` に書いて、`node setup/setup.mjs --target prod --only chatwoot-prod` を実行する
5. 止まったら、表示されたコマンドで FAQ ボットの access_token と secret を Secrets Manager に入れ（値は画面に出さず、パイプで渡す）、案内に出るトークンの指紋（SHA-256 の先頭 8 文字。秘密値ではない）を `FAQ_BOT_SECRETS_STORED=<指紋>` に書いて実行し直す。ボットが作り直されてトークンが変わると指紋が合わなくなり、もう一度入れるよう案内される

管理者のトークン（`CHATWOOT_ADMIN_TOKEN`）は `prod.conf` だけに置き、状態ファイルには写さない。初期設定が終わったら `prod.conf` から消してよい（その後の `chatwoot-prod` は止まって案内する）。

ほかの担当者は、各自のプロフィールで「新しい会話が作成されたとき」のメール通知を有効にする（本人のトークンでしか変えられない。`cloud/README.md` の 4.17 の 7）。

### 8.4 本番の Mautic（`mautic-prod`）

開発の `mautic` と同じ API の手順（カスタム項目・フォーム consult と自動返信・セグメント mql）を、本番（`https://mkt.comegin.com`）に向けて行う。本番の `config/local.php` は EFS にあり、開発のように PHP で書き換えないので、設定は画面で行う（止まったときの案内のとおり）。

- インストール（`/installer`）、API の有効化、Webhook のキューモード（`command_process`）と私設アドレスの許可（`10.99.0.2` だけ。オンプレのアドレスを変えたら `prod.conf` の `ONPREM_WEBHOOK_HOST`）、CORS（本番の公開サイトのオリジンだけ）、メール（SES の SMTP）
- 初期設定用の API 認証情報（管理者が作る）を `MAUTIC_SETUP_CLIENT_ID=`・`MAUTIC_SETUP_CLIENT_SECRET=` に書く（エージェント用の `MAUTIC_CLIENT_*`・analytics-reporter 用の `MAUTIC_RO_CLIENT_*` とは別の認証情報にする。どれも上流の権限は管理者〈8.2〉。初期設定が終わったら画面で消してよい）
- 済んだら `MAUTIC_PROD_SETTINGS_DONE=yes`（設定は EFS の中で、外から確かめられないため申告制）

Mautic と Chatwoot から n8n（I-11・I-12）への Webhook は、オンプレの本番の n8n の provision が作る（`middleware/n8n/provision`。宛先は `http://10.99.0.2:5680/webhook/...`）。

### 8.5 AWS のデプロイ（`cloud`）

本番の段階 `env`・`deploy`・`images` は `cloud`（`cloud/setup/index.mjs`）が受け持つ（`setup/README.md` の「本番の段階」）。AWS には読み取り（`sts get-caller-identity`・`cloudformation describe-stacks`・`ecr describe-images`・`secretsmanager describe-secret`）しか行わず、デプロイ・プッシュ・Secret の値の書き込みは人が自分の端末で行う（`cloud/README.md` の 2 節）。`samconfig.toml` の値と Secret の値は表示しない。

| 表示の id | すること |
|---|---|
| `cloud:env` | AWS CLI・SAM CLI（1.154 以上）・Docker・pnpm 11 を入れる。AWS の認証は `AWS_PROFILE` か `aws sso login`（アカウントが既定の `798560359429` でなければ止まる。別のアカウントに出すなら `prod.conf` の `AWS_ACCOUNT_ID`）。`cp cloud/samconfig.toml.example cloud/samconfig.toml`（600）にして、`RunLogAdminPrincipalArns`・`GoogleClientId`・`AdminBootstrapEmails` を書く（CloudFront の 2 つは次の段階で書く） |
| `cloud:global` | `cd cloud && sam deploy --config-env global`（`cloud/README.md` の 4.1） |
| `cloud:cloudfront-params` | 表示された global の出力（`CertificateArn`・`WebAclArn`）を `samconfig.toml` の `CloudFrontCertificateArn`・`CloudFrontWebAclArn` に書く |
| `cloud:sam-deploy` | `cd cloud && sam build`（必須）→ `sam deploy`（4.2）。ECR のリポジトリもここで作られる。実行中なら終わるまで待つ。失敗しているなら CloudFormation のイベントで原因を確かめる |
| `cloud:secrets` | `comegin/prod/admin-auth/GOOGLE_CLIENT_SECRET` に値を入れる（4.6）。SMTP の 4 つ（4.9）は警告だけで、Chatwoot・Mautic の DesiredCount を上げる前（4.11）に入れる。FAQ ボットの 2 つは `chatwoot-prod`（段階 `apps`）が案内する |
| `cloud:push` | 表示されたコマンド（ECR へのログイン → `docker build --platform linux/amd64` → `docker push`）を実行する（4.7）。タグは本番スタックのパラメータ `ChatwootImageTag`・`MauticImageTag` の今の値。上流のタグとダイジェストは `cloud/README.md` の 4.7 の表と `cloud/setup/index.mjs` の `IMAGES` の両方に書いてある（版を上げたら両方を変える） |

## 9. ログイン先の一覧

スクリプトが作った管理者のパスワードは `node setup/setup.mjs --target dev --show <KEY>` で見る（画面に出るので、人のいない場所で）。

| 製品 | URL | ユーザー | パスワード |
|---|---|---|---|
| Chatwoot | http://127.0.0.1:3100 | `ADMIN_EMAIL` | `--show CHATWOOT_ADMIN_PASSWORD` |
| Mautic | http://127.0.0.1:8000/s/login | `admin` | `--show MAUTIC_ADMIN_PASSWORD`（スクリプトがインストールした場合だけ） |
| Strapi | http://127.0.0.1:1337/admin | `ADMIN_EMAIL` | `--show STRAPI_ADMIN_PASSWORD`（スクリプトが作った場合だけ） |
| n8n | http://127.0.0.1:5678 | `ADMIN_EMAIL` | `--show N8N_OWNER_PASSWORD`（スクリプトが作った場合だけ） |
| 監視アプリ | `<BETTER_AUTH_URL>/login`（いまの開発は https://comegin-next-js-dev.ngrok.app/login） | Google（`CONTROL_ADMIN_EMAILS` のアカウント） | なし（Google でログイン。7.2） |
| MailHog（開発のメール） | http://127.0.0.1:8025 | なし | なし |

手で作った管理者のパスワードを `dev.conf` に書いた場合は、そちらを使う（状態には入らない）。
