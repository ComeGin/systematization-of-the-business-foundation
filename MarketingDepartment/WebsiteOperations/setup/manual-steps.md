# 設定スクリプトで人が行う操作（画面・端末）

`node setup/setup.mjs --target dev` は、公式の CLI と API でできることだけを自動で行う。
それ以外の操作に当たると、**手順を表示して止まる**（終了コード 3）。この文書は、その操作をまとめたもの。
操作が終わったら、**同じコマンドを実行し直す**。済んだ手順は飛ばして、続きから進む。

パスは `MarketingDepartment/WebsiteOperations/` からの相対。画面の表記は、各製品の開発環境の言語（Mautic・n8n は英語）に合わせてある。
画面の表記は 2026-10-05 に各製品のソース（翻訳ファイル）で確かめた。版が上がって表記が変わっていたら、この文書を直す。

## 0. 早見表

止まったときの表示「画面での操作が必要: …（`<id>`）」の `<id>` で引く。

| 表示の id | いつ止まるか | 何をするか | 節 |
|---|---|---|---|
| `mautic:api-credentials`／`n8n:mautic-api-credentials` | Mautic の API 資格情報が設定に無い | **Mautic の画面で資格情報を作る**（必ず 1 回は要る） | [2](#2-mautic-の-api-資格情報必須) |
| `chatwoot:admin-password` | 以前に手で作った管理者がいる | パスワードを設定に書く／作り直しを許す | [3.1](#31-chatwoot) |
| （mautic の失敗） | Mautic の管理者のパスワードが分からない | 画面の「Forgot your password?」 | [3.2](#32-mautic) |
| `umami:admin-password` | 管理者のパスワードが初期値から変わっている | パスワードを設定に書く | [3.3](#33-umami) |
| `strapi:admin-password`／`strapi:admin-login` | 以前に手で作った管理者がいる | パスワードを設定に書く | [3.4](#34-strapi) |
| `n8n:owner-password`／`n8n:owner-login` | 以前に手で作ったオーナーがいる | パスワードを設定に書く | [3.5](#35-n8n) |
| `n8n:mcp-token` | n8n の MCP のトークンが作成済み | 控えを写す／作り直しを許す | [4](#4-n8n-の-mcp-のトークン) |
| `n8n:mcp-managed-by-env` | MCP の設定が環境変数で固定されている | 画面で有効か確かめる | [4](#4-n8n-の-mcp-のトークン) |
| `strapi:start-dev`／`next-js:start-app`／`next-js:restart-app` | 開発サーバーが動いていない／環境変数を書き換えた | 別の端末で起動（し直し）したままにする | [5](#5-常駐させる開発サーバーの起動) |
| （next-js の失敗）`CONTROL_MAIN_CHECKOUT が無い` | 承認済みの `main` のチェックアウトが無い | `git worktree` で作る | [6](#6-監視アプリの承認済みの-main-のチェックアウト) |
| `next-js:google-client` | 監視アプリの Google ログインの OAuth クライアントが無い | **Google Cloud Console で作る**（必須。ADR-23） | [7.2](#72-監視アプリの-google-ログイン必須) |
| （警告だけ） | admin-auth の Google の資格情報・Anthropic の API キーが無い | 試すときだけ作る | [7](#7-外部サービスの資格情報) |
| `onprem:onprem-bringup`（`--target prod`） | 本番のオンプレ | AWS のデプロイの後 | [8](#8-本番--target-prod) |

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

### 3.3 Umami

| 状況 | すること |
|---|---|
| パスワードを知っている | `dev.conf` に `UMAMI_ADMIN_PASSWORD=<今のパスワード>`（ユーザー名は `admin`） |
| 知らない | Umami には API・CLI でパスワードを再設定する手段が無い。開発環境の Umami のデータを作り直してよければ、自分で `cd middleware/umami-master && docker compose -f docker-compose.yml -f dev/setup/compose.mcp.yml down -v` を実行してから再実行する（スクリプトはデータを消さない。初期の管理者 `admin` / `umami` に戻り、スクリプトがパスワードを変える） |

2 要素認証を設定している管理者は、API でログインできないので止まる（解除してから再実行）。

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

# いまのブランチ（13-feature-develop-backend）が main に入るまでは、origin/main に ops/mcp-registry.yaml がまだ無い。
# それまでの開発の確認では、ブランチのコミットから作る（読むだけのチェックアウトなので detached でよい）
git worktree add --detach ~/ComeGin/main-checkout 13-feature-develop-backend

# main にマージした後は、origin/main に合わせる（以後、承認のたびにこれで更新する）
git -C ~/ComeGin/main-checkout checkout --detach origin/main
```

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

## 8. 本番（`--target prod`）

いまは枠だけ。`onprem` は、AWS のデプロイ（`cloud/README.md`）の後に WireGuard → Strapi → n8n の順で人が立ち上げる手順を表示する。手順の正本は `onprem/README.md` と `onprem/wireguard/README.md`。

## 9. ログイン先の一覧

スクリプトが作った管理者のパスワードは `node setup/setup.mjs --target dev --show <KEY>` で見る（画面に出るので、人のいない場所で）。

| 製品 | URL | ユーザー | パスワード |
|---|---|---|---|
| Chatwoot | http://127.0.0.1:3100 | `ADMIN_EMAIL` | `--show CHATWOOT_ADMIN_PASSWORD` |
| Mautic | http://127.0.0.1:8000/s/login | `admin` | `--show MAUTIC_ADMIN_PASSWORD`（スクリプトがインストールした場合だけ） |
| Umami | http://127.0.0.1:3000 | `admin` | `--show UMAMI_ADMIN_PASSWORD` |
| Strapi | http://127.0.0.1:1337/admin | `ADMIN_EMAIL` | `--show STRAPI_ADMIN_PASSWORD`（スクリプトが作った場合だけ） |
| n8n | http://127.0.0.1:5678 | `ADMIN_EMAIL` | `--show N8N_OWNER_PASSWORD`（スクリプトが作った場合だけ） |
| 監視アプリ | `<BETTER_AUTH_URL>/login`（いまの開発は https://comegin-next-js-dev.ngrok.app/login） | Google（`CONTROL_ADMIN_EMAILS` のアカウント） | なし（Google でログイン。7.2） |
| MailHog（開発のメール） | http://127.0.0.1:8025 | なし | なし |

手で作った管理者のパスワードを `dev.conf` に書いた場合は、そちらを使う（状態には入らない）。
