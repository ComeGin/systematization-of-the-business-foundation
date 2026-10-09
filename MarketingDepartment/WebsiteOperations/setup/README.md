# バックエンド全体の設定スクリプト（setup/）

オンプレの開発環境（`--target dev`）を、1 本のコマンドで最初から最後まで用意する。
各製品の起動・管理者の作成・トークンの発行・MCP の env ファイル・n8n のワークフローの取り込みまでを、**公式の CLI と API だけで**行う。
画面でしかできない操作に当たると、手順を表示して止まる。終わったら同じコマンドを実行し直せば、済んだ手順は飛ばして続きから進む。

本番（`--target prod`）は枠だけ（AWS のデプロイの後に実装する。ADR-21）。

## 使い方

```bash
cd MarketingDepartment/WebsiteOperations

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
| `--check` | 何も変えずに、各モジュールの状態を表示する |
| `--only <id,...>` | 指定したモジュールだけ（id は `--list` で見る） |
| `--from <id>` | 指定したモジュールから後ろだけ（失敗したあとに続きから） |
| `--list` | モジュールの一覧と順番 |
| `--show <KEY>` | 状態ファイルの値を 1 つ表示する（作った管理者のパスワードなど。**秘密値も表示する**） |
| `--config <path>` | 設定ファイルの場所を変える（指定したファイルが無ければ、何も実行せずに `1` で終わる。省略時の既定の場所に無いのは初回として空の設定で進む） |

`--only`・`--from`・`--show`・`--config` の値が無い・空・次のオプション（`-` で始まる）のとき、`--only`・`--from` に `--list` に無い id（この target では動かないものを含む）を渡したときは、何も実行せずに `1` で終わる。

終了コード: `0` 終わった／`1` 失敗（直してから `--from <id>`）／`3` 画面の操作が必要（案内に従って再実行）。

## モジュール（実行の順）

| id | 場所 | 自動でやること | 止まって頼むこと（manual） |
|---|---|---|---|
| `host-relay` | `middleware/host-relay/setup/` | 中継の起動（172.17.0.1 の 8000・1025・5678） | なし |
| `chatwoot` | `backend/chatwoot-system/setup/` | init-env・DB の準備（イメージが変わったときだけ）・起動・Webhook の私設アドレスへの送信の許可（下の「Webhook の送り先と SSRF 対策」）・管理者とアカウント・管理者のトークン・エージェント専用ユーザー（担当者の権限）とトークン・Web サイトの受信箱とメンバー。onboarding 画面を閉じる | 管理者が既にいてパスワードが分からない（`CHATWOOT_ADMIN_PASSWORD` を書くか `CHATWOOT_RESET_ADMIN_PASSWORD=yes`） |
| `mautic` | `backend/mautic-system/dev/setup/` | MySQL・MailHog と PHP サーバーの起動（端末から切り離す。ログは `~/.config/comegin/setup/mautic-serve.log`）・未インストールならインストール・Webhook の設定（送り先の私設アドレスの許可・失敗での自動停止の無効化）・カスタム項目 3 つ・フォーム `consult`・`source_dl`・セグメント `mql` | **API 資格情報の作成**（画面だけ。下の「画面での操作」） |
| `ga4` | `middleware/ga4/setup/`（dev・prod） | **dev**: 開発の Astro の環境変数に測定 ID が無いことの確認だけ（あれば失敗）。**prod**: `GA4_PROPERTY_ID`（数字）と `GA4_MEASUREMENT_ID`（`G-…`）の形式の確認（GA4 は SaaS。API は呼ばない。ADR-25） | prod だけ: 本番の GA4 プロパティの作成と設定（`ga4:property`） |
| `openseo` | `middleware/open-seo-main/dev/setup/`（dev・prod） | 環境変数ファイル（空のキーだけ。`BETTER_AUTH_SECRET` を生成、`AUTH_MODE=local_noauth`）・起動・`/api/health` の確認 | DataForSEO のキー／**prod だけ**（dev は AWS に展開されていないので飛ばす）: Search Console と GA4 用の OAuth クライアント（GA4 は Analytics Admin API・Data API の有効化と `/api/ga4/oauth/callback` を含む）／Search Console の接続（画面）／GA4 の接続（画面。本番のプロパティだけ。ADR-25） |
| `strapi` | `backend/strapi-system/setup/` | 環境変数ファイル・`pnpm install`・管理者（0 人のときだけ）・MCP 用の Admin トークン（下書きまで）・ビルド用の読み取りトークン → `strapi-dev.env` | 開発サーバーの起動（別の端末で `pnpm dev`）／既にいる管理者のパスワード |
| `n8n` | `middleware/n8n/setup/` | init-env・起動・オーナー・公開 API のキー・MCP の有効化とトークン → `n8n-dev.env`・provision（Data Table・Mautic と Chatwoot の Webhook・資格情報・ワークフローの取り込みと子の公開） | 既にいるオーナーのパスワード／作成済みの MCP トークン（写すか `N8N_MCP_ROTATE=true`） |
| `consent-api` | `backend/consent-api/setup/` | 環境変数ファイル・起動（Valkey 付き）・`/healthz` | なし |
| `admin-auth` | `backend/admin-auth/setup/` | init-env・起動・discovery と JWKS の確認。許可リストに `ADMIN_EMAIL` | なし（Google の資格情報は任意。無ければ警告だけ） |
| `chatwoot-mcp` | `backend/chatwoot-mcp/setup/` | `pnpm install`・`pnpm build`・トークンの確認 → `chatwoot-dev.env` | なし |
| `mautic-mcp` | `backend/mautic-mcp/setup/` | `pnpm install`・`pnpm build`・資格情報の確認 → `mautic-dev.env` | なし（資格情報が無ければ失敗。mautic を先に） |
| `control-plane` | `backend/control-plane/setup/` | Node と pnpm の版の確認・`pnpm install`・`pnpm build`・E-15 の置き場（700） | なし |
| `next-js` | `frontend/next-js/setup/` | init-env・`CONTROL_*` の値・Google の資格情報と許可リスト（`CONTROL_ADMIN_EMAILS`）・`pnpm install`・Google ログインを始められるかの確認（認可 URL の `hd` とリダイレクト URI） | `CONTROL_MAIN_CHECKOUT` が無い（失敗として止まる）／**Google の OAuth クライアントの作成**／監視アプリの起動・起動し直し（別の端末で `pnpm dev`） |
| `onprem` | `onprem/setup/`（prod だけ） | 読むだけの確認（wg0・systemd・待ち受け） | 本番の立ち上げ手順の案内（枠だけ） |

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
| `MAUTIC_FORM_ID_CONSULT`・`MAUTIC_FORM_ID_SOURCE_DL`・`MAUTIC_SEGMENT_ID_MQL` | mautic | 公開サイト（Astro の環境変数）に写す |
| `STRAPI_ADMIN_PASSWORD`✔・`STRAPI_DEV_TOKEN`✔・`STRAPI_BUILD_TOKEN`✔ | strapi | 管理者のログイン／strapi-mcp／Astro のビルド |
| `N8N_OWNER_PASSWORD`✔・`N8N_API_KEY`✔・`N8N_DEV_TOKEN`✔ | n8n | オーナーのログイン／provision／n8n の MCP |

管理者のメールアドレスはすべて `ADMIN_EMAIL`（Chatwoot のエージェント専用ユーザーだけは `+ai-agent` 付き）。

**MCP の env ファイル**（`~/.config/comegin/mcp/`、600。`ops/mcp-registry.yaml` が参照する）: `chatwoot-dev.env`・`mautic-dev.env`・`strapi-dev.env`・`n8n-dev.env`（`umami-dev.env` は ADR-25 で Umami を廃止したので作らない。前に作られたものは自分で消す）。

**各プロジェクトの環境変数ファイル**: 既存の `dev/init-env.sh` と同じく、**空のキーだけを書く**（暗号化の鍵などを上書きしない）。

## Webhook の送り先と SSRF 対策

Mautic と Chatwoot は、私設アドレスへの Webhook を既定で送らない（SSRF 対策）。n8n の受け口（I-11・I-12）は開発も本番も私設アドレスなので、許可が要る。

| | 開発（このスクリプトが設定する） | 本番（ADR-21。宛先は WireGuard 越しの `10.99.0.2:5680`。人が設定する） |
|---|---|---|
| Mautic | `config/local.php` の `webhook_allowed_private_addresses` に `127.0.0.1`（`MAUTIC_WEBHOOK_TARGET` のホスト）を足す（`dev/allow-webhook-private-addresses.php`。キャッシュも捨てる） | 同じ項目（設定 > Webhook 設定）に **`10.99.0.2` だけ**を入れる。範囲（`10.0.0.0/8` など）では許可しない |
| Mautic の自動停止 | `disable_auto_unpublish` を `true`（`dev/disable-webhook-auto-unpublish.php`）。開発は I-11 が未公開（404）なのが既定なので、失敗で「n8n I-11」が止まらないようにする | **`false` のまま**（失敗が続いた Webhook は止まる）。止まったら n8n の provision を実行し直して公開に戻す（非公開の「n8n I-11」を公開にする） |
| Mautic の CORS（Webhook ではないが同じ `local.php` を書く） | `cors_valid_domains` に公開サイトの開発のオリジン（`http://localhost:4321`・`http://localhost:4322`・`https://comegin-astro-dev.ngrok.app`。`dev.conf` の `MAUTIC_CORS_VALID_DOMAINS` で変えられる）を足す（`dev/allow-cors-domains.php`）。無いとフォームの応答を読めず、画面は「送信できませんでした」になる | 同じ項目（設定 > システム設定 > CORS 設定）に**本番の公開サイトのオリジンだけ**を入れる。「ドメインを制限する」は Yes のまま |
| Chatwoot | `.env` の `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`（`dev/init-env.sh`）。rails と sidekiq を作り直して反映する | 宛先ごとの許可が無く、私設アドレス全体を開ける切り替えしか無い。**本番でも `true` が要る**ので、Chatwoot のタスクのセキュリティグループの出口を、必要な私設アドレス（RDS・ElastiCache と `10.99.0.2:5680`）だけに絞る |

許可が無いと、Mautic は webhook_logs に `Access to private addresses is not allowed.` を、Chatwoot は Sidekiq のログに `has no public ip addresses` を残すだけで、n8n には何も届かない（Chatwoot は再送しない）。

## 秘密値の扱い

- 生成した秘密値は状態ファイルにだけ置き、画面・ログ・例外の文に出さない（`--show` で明示したときだけ表示）
- 子プロセスに秘密値を渡すときは、コマンドライン引数ではなく標準入力か環境変数を使う（`ps` に出さない）。Strapi の管理者は CLI（`admin:create-user`）がパスワードを引数でしか受けないため、管理 API（`/admin/register-admin`）で作る
- 子プロセスの出力は貯めておき、失敗したときだけ最後の 20 行を伏せ字にして表示する

## モジュールを足すとき

1. `<モジュール>/setup/index.mjs` に、`setup/lib/core.mjs` の冒頭に書いた形（`meta`・`check`・`apply`）で書く。見本は `middleware/host-relay/setup/index.mjs`
2. `setup/setup.mjs` の `MODULES` に、依存の順で 1 行足す
3. 新しい設定のキーは `setup.conf.example` に、新しい状態のキーはこの README の「作られる値」に足す

## 既知の未確認（最初の実行で分かる）

各モジュールの API の応答の形は、動いているコンテナの中のソースから確かめたもので、認証が要る呼び出しはまだ実機で通していない。失敗したら、表示された HTTP の状態と理由を添えて知らせる。直してから `--from <id>` で続きから実行する。
