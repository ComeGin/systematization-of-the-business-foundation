# 構築の全体手順と、人が行う作業（開発 → 本番）

設定の手順が `setup/`（設定スクリプト）・`cloud/`（AWS の IaC）・`onprem/`（オンプレの本番）・`middleware/n8n/provision/` に分かれていて、
**どの順で、だれが、何をするか**が 1 か所で見えなかった。この文書はその**順番と分担の地図**で、細かい手順は各 README（正本）に任せる。
各手順の「詳細」の列から、正本の節に飛ぶ。

パスはリポジトリのルートからの相対。`cloud/README.md` の節は「cloud 4.8」のように、`setup/manual-steps.md` の節は「manual 8.3」のように書く。

## 0. 読み方

### だれが行うか（ラベル）

| ラベル | 意味 |
|---|---|
| **自動** | 設定スクリプト（`setup/setup.mjs`・`setup/frontend.mjs`）が行う。人は実行するだけ |
| **人・端末** | 人が**自分の端末**でコマンドを打つ。AWS への書き込み（デプロイ・Secret・Lambda の呼び出し）・秘密値の受け渡し・`/etc` への書き込み。**Claude Code には行わせない**（cloud 2 の「デプロイは運用者が実行する」） |
| **人・画面** | 管理画面や外部サービス（Google Cloud・SES・GA4 など）での操作 |
| **判断** | R1 が決める（決めるまで既定のまま動く） |

### 見落としやすい 3 種類の手順

- **〔未検査〕**: 設定スクリプトが**確かめない**手順。済ませていなくてもスクリプトは先へ進む（か、別の名前で止まる）ので、この文書の順で自分で済ませる。一覧は [4 節](#4-設定スクリプトが確かめる範囲)
- **〔警告〕**: スクリプトが読み取りで確かめるが、**止めずに `!` の警告だけ出す**手順（済んでいなくても後の設定は進められるもの）。警告が消えるまでに済ませる
- **〔申告〕**: スクリプトが外から確かめられないので、人が `prod.conf` に `...=yes` を書いて「済んだ」と伝える手順。書いたら信じて進むので、**済ませてから書く**。一覧は [5 節](#5-申告制のフラグprodconf)

### 設定スクリプトの基本の動き

```bash
node setup/setup.mjs --target <dev|prod> [--phase <段階>] [--check]
```

- 止まったら（終了コード 3）、表示された手順を行い、**同じコマンドを実行し直す**。済んだ手順は飛ばす。
- 止まったときの表示の id（例 `cloud:secrets`）は、[`setup/manual-steps.md`](../../setup/manual-steps.md) の 0 節の早見表で引ける。
- 人が書く値は `~/.config/comegin/setup/<dev|prod>.conf`（600）。スクリプトが作った値は `<dev|prod>.state.json` に入り、`--show <KEY>` で見る。

## 1. 文書の地図（どれが何の正本か）

| 文書 | 正本としての中身 | いつ読むか |
|---|---|---|
| **この文書** | 全体の順番・分担・見落としやすい手順 | 最初と、迷ったとき |
| [`setup/README.md`](../../setup/README.md) | 設定スクリプトの使い方・モジュールの一覧・本番の 5 段階 | スクリプトを実行するとき |
| [`setup/manual-steps.md`](../../setup/manual-steps.md) | スクリプトが止まったときの画面・端末の操作（id で引く） | スクリプトが止まったとき |
| [`cloud/README.md`](../../cloud/README.md) | AWS の構成・費用・デプロイと運用のコマンド（4.1〜4.19） | 本番の AWS を触るとき |
| [`onprem/README.md`](../../onprem/README.md)・[`onprem/wireguard/README.md`](../../onprem/wireguard/README.md) | オンプレの本番の Strapi・n8n・WireGuard の立ち上げ | 本番のオンプレを上げるとき |
| [`middleware/n8n/provision/README.md`](../../middleware/n8n/provision/README.md) | n8n の資格情報・ワークフロー・Webhook の作成（**本番は設定スクリプトに入っていない**） | 本番の n8n を設定するとき |
| [`docs/runbooks/01-onprem-verification.md`](01-onprem-verification.md) | 開発環境での動作確認（Wave 4） | 開発環境を確かめるとき |

## 2. 開発環境（`--target dev`）

AWS は使わない。ほとんど自動で、人の作業は次の表だけ。

| 順 | だれが | すること | 詳細 |
|---|---|---|---|
| D1 | 人・端末 | `cp setup/setup.conf.example ~/.config/comegin/setup/dev.conf`（600）にして `ADMIN_EMAIL` を書く | setup「使い方」 |
| D2 | 人・端末 | 承認済みの `main` のチェックアウトを作る（`git worktree add --detach ~/ComeGin/main-checkout origin/main`）→ `CONTROL_MAIN_CHECKOUT` に書く | manual 6 |
| D3 | 人・画面 | Google Cloud で監視アプリのログイン用の OAuth クライアントを作り、`CONTROL_GOOGLE_CLIENT_*` に書く（**必須**） | manual 7.2 |
| D4 | 自動 | `node setup/setup.mjs --target dev` | setup「モジュール」 |
| D5 | 人・画面 | 止まったら: **Mautic の API 資格情報**（必ず 1 回）・DataForSEO のキー・既にいる管理者のパスワード・n8n の MCP のトークン | manual 2・3・4・7.4 |
| D6 | 人・端末 | 止まったら: 別の端末で `pnpm dev` を起動したままにする（Strapi・監視アプリ） | manual 5 |
| D7 | 自動 | `node setup/frontend.mjs --target dev`（D4 の後。公開サイトの `.env` は D4 が作った値から写す） | setup「フロントエンド全体」 |
| D8 | 人・画面 | 任意: admin-auth の Google ログイン・`ANTHROPIC_API_KEY` | manual 7.1・7.3 |

開発では GA4・Search Console の手順は出ない（タグを出さない。ADR-25）。

## 3. 本番（`--target prod`）

設定スクリプトの段階は `env → deploy → images → apps → google` の 5 つ（setup「本番の段階」）。
2026-10-28 から、段階 `apps` の前提（DB の作成・ECS の台数）と本番の n8n の provision もスクリプトが確かめる・行う。残る〔未検査〕は配信と運用開始の仕上げが中心。

```
P1 env ─ P2 deploy ─ P3 images ─┬─ P4 データ層の仕上げ（cloud）
                                ├─ P5 admin-auth
                                ├─ P6 オンプレ（WireGuard → Strapi → n8n）
                                ├─ P7 Chatwoot ─┐
                                ├─ P8 Mautic   ─┼─ P9 本番の n8n（n8n-prod）
                                └───────────────┴─ P10 本番の MCP ─ P11 公開サイトの値
P12 ビルドと配信〔未検査〕 ─ P13 google ─ P14 運用開始の仕上げ〔未検査〕
```

`P4`〜`P10` は 1 回の `node setup/setup.mjs --target prod --phase apps` の中で、止まるたびに 1 つずつ進む（モジュールの順は cloud → admin-auth → onprem → chatwoot-prod → mautic-prod → n8n-prod → mcp-prod）。`P11` は `node setup/frontend.mjs --target prod`。

> 記録上（各 README の 2026-10-28 までの記述）は、P1〜P3 と、P6 の WireGuard・Strapi・n8n の起動までが本番で通っている。下のチェックは各自で付ける。

### P1. 段階 `env`: 道具と設定ファイル

`node setup/setup.mjs --target prod --phase env`（止まる id は `cloud:env`）

- [ ] **人・端末** AWS CLI・SAM CLI 1.154 以上・Docker・pnpm 11 を入れ、`aws sso login` などで認証する（アカウント `798560359429`）— cloud 2
- [ ] **人・端末** `cp cloud/samconfig.toml.example cloud/samconfig.toml`（600）— cloud 2
- [ ] **人・画面** Google Cloud で admin-auth（本番）の OAuth クライアントを作る。リダイレクト URI は `https://auth.comegin.com/api/auth/callback/google`。ID を `GoogleClientId` に書く（シークレットは P2 で Secret に入れる）— cloud 4.6
- [ ] **人・端末** `samconfig.toml` に `RunLogAdminPrincipalArns`（デプロイに使う主体の ARN。忘れると E-15 のバケットが自分の更新を拒否して詰む）・`GoogleClientId`・`AdminBootstrapEmails` を書く — cloud 2
- 〔未検査〕Lambda の同時実行数の上限が 121 以上か（このアカウントは 2026-10-27 に 1,000 を確認済み。別のアカウントに出すときだけ）— cloud 2

**守ること**: 既定値と違うパラメータは**すべて `samconfig.toml` に書く**（書かなかったものはデプロイのたびに既定値に戻る。`DesiredCount` が 0 に戻ってサービスが止まる）— cloud 2「重要」

### P2. 段階 `deploy`: スタックを作る

`node setup/setup.mjs --target prod --phase deploy`（止まる id は `cloud:global`・`cloud:cloudfront-params`・`cloud:sam-deploy`・`cloud:secrets`）

- [ ] **人・端末** `cd cloud && sam deploy --config-env global`（us-east-1。ACM と CloudFront 用 WAF）— cloud 4.1
- [ ] **人・端末** 出力の `CertificateArn`・`WebAclArn` を `CloudFrontCertificateArn`・`CloudFrontWebAclArn` に書く — cloud 4.1
- [ ] **人・端末** `sam build && sam deploy`（`sam build` は省けない。Lambda 3 つが空の zip になる）。ECS のサービスは**全部 0 台**で作られる — cloud 4.2
- [ ] **人・端末** Secret `comegin/prod/admin-auth/GOOGLE_CLIENT_SECRET` に値を入れる（`read -rs` で履歴に残さない）— cloud 4.6
- [ ] 〔警告〕**人・端末** global の 2 回目: 出力の `DistributionArn` を global の設定に足して `sam deploy --config-env global`（フラットレートプランの購読。Free Tier の期間のアカウントは購読できない）— cloud 4.3
- [ ] 〔警告〕**人・端末** SNS の 2 トピック（`comegin-ops-alert`・`comegin-lead-alert`）をメールで購読し、`--authenticate-on-unsubscribe true` を付けて確認する（メールのリンクは踏まない。付けずに確認した購読も警告に出る）— cloud 4.4

〔警告〕の 2 つは、段階 `apps` の最初（`cloud`）が読み取りで確かめる。SES の本番アクセスの申請は、公開サイトを配信した後に行う（P12）。

### P3. 段階 `images`: 派生イメージ

`node setup/setup.mjs --target prod --phase images`（止まる id は `cloud:push`）

- [ ] **人・端末** Chatwoot・Mautic の派生イメージを `--platform linux/amd64` でビルドして ECR にプッシュする（表示されたコマンド）— cloud 4.7
- [ ] **人・端末** タグ（`ChatwootImageTag`・`MauticImageTag`）を `samconfig.toml` に書いて `sam deploy`（`REPLACE-WITH-FIXED-TAG` のままでは起動しない）— cloud 4.7

### P4. データ層の仕上げ（`cloud` の段階 `apps`）

段階 `apps` のすべての前提。止まる id は `cloud:db-init`。ここで P2・P4・P6 の〔警告〕もまとめて出る。

- [ ] **人・端末** DB とアプリ用ユーザーを作る: ECS の RunTask で `comegin-prod-db-init-postgres`（chatwoot・admin_auth・strapi・n8n）と `comegin-prod-db-init-mysql`（mautic）。ログの最後が `... done`（スクリプトは、今のスタックの作成の後の成功のログを読む）— cloud 4.8
- [ ] 〔警告〕**人・画面** SES の SMTP 認証情報を **Mautic 用と Chatwoot 用で別々に**発行し、Secret 4 つ（`mautic/SMTP_*`・`chatwoot/SMTP_*`）に入れる — cloud 4.9.3・4.9.4
- [ ] 〔警告〕**人・画面** DKIM と MAIL FROM が `SUCCESS` になるのを待ち、apex（`comegin.com`）に DMARC の TXT を足す（`p=none` から。`aspf=s` は入れない。apex の SPF は Google Workspace のまま触らない）— cloud 4.9.1・4.9.6

### P5. admin-auth（管理画面の関門）

止まる id は `admin-auth:prod-migrate`。**これが済むまで、Chatwoot・Mautic の管理画面に誰も入れない**（P7・P8 の画面の操作の前提）。

- [ ] **人・端末** 運用の Lambda（`admin-auth-ops`）に `{"action":"migrate"}` → `{"action":"register-alb-client"}`（どちらも `{"ok":true}`）— cloud 4.19・manual 8.1
- [ ] **人・画面** 管理画面（`https://chat.comegin.com/app/` など）を開き、Google でログインして戻ってこられることを確かめる（Chatwoot が 0 台のあいだは戻った先が 503 でよい）
- [ ] **〔申告〕** `prod.conf` に `ADMIN_AUTH_PROD_READY=yes`

### P6. オンプレの本番（WireGuard → Strapi → n8n）

止まる id は `onprem:onprem-bringup`（**スクリプトは確かめるだけで、手順はすべて人が行う**）。順番は必ず WireGuard → Strapi → n8n。

- [ ] **人・端末** WireGuard: 鍵を作る → オンプレの公開鍵を **SSM と `samconfig.toml` の両方**に入れる → EC2 の公開鍵と Elastic IP を取り出す → `render-conf.sh` → `/etc/wireguard/wg0.conf` → `systemctl enable --now wg-quick@wg0` → 疎通 — cloud 4.2.1 の手順 1〜6
- [ ] 〔警告〕**人・端末** WireGuard の AMI を固定する（`WireguardFixedAmiId` を `samconfig.toml` に書く。固定しないと新しい AMI のデプロイで EC2 が置き換わり、鍵が変わる）— cloud 4.2.1 の手順 3
- [ ] 〔警告〕**人・端末** IAM ユーザー 2 つのアクセスキーを発行する（`onprem-strapi-media` は Strapi の `.env`、`onprem-n8n-sns` は P9 で `prod.conf` の `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`。ファイルに直接書いて、写したら `shred -u`）— cloud 4.5
- [ ] **人・端末** RDS の `strapi`・`n8n` のパスワード（Secret。**P4 の DB 作成の後**に取り出す）と PostgreSQL のエンドポイントを、`onprem/strapi/.env`・`onprem/n8n/.env` に写す — cloud 4.8・onprem「起動の順番」
- [ ] **人・端末** Strapi: `./dev/init-env.sh` → `.env` に値 → `docker compose build && up -d` → `/_health` が 204 — onprem 2
- [ ] **人・端末** n8n: `./dev/init-env.sh`（**`N8N_ENCRYPTION_KEY` を別の場所に控える**）→ `.env` に値 → `docker compose build && up -d` → `/healthz` — onprem 3
- [ ] **人・端末** systemd のユニットを置く（`CHANGE_ME` を書き換えてから `/etc/systemd/system/` に）— onprem「常駐させる」
- [ ] 〔未検査〕**人・画面** 本番の Strapi（`http://127.0.0.1:1338/admin`）で最初の管理者を作り、トークンを 2 つ発行する: 公開サイトのビルド用の読み取り専用（article・category・author の find / findOne だけ → `SITE_STRAPI_API_TOKEN`）と、MCP 用の Admin トークン（**下書きまで** → `STRAPI_PROD_TOKEN`）— manual 8.2・setup.conf.example
- 本番の n8n のオーナー・公開 API のキー・MCP のトークンは、P9 の `n8n-prod` が作る（画面で作らない。先に作ってしまったなら manual 8.6）

### P7. Chatwoot（`chatwoot-prod`）

止まる id は `chatwoot-prod:ecs`・`chatwoot-prod:onboarding`・`chatwoot-prod:faq-bot-secrets`。

- [ ] 〔未検査〕**人・端末** `db:chatwoot_prepare` を RunTask で実行する（**初回とイメージの更新のたび**。exitCode が 0。スクリプトは移行の有無を読めないが、`chatwoot-prod:ecs` の案内に手順が出る）— cloud 4.10
- [ ] **人・端末** `samconfig.toml` に `ChatwootWebDesiredCount=1` → `ChatwootWorkerDesiredCount=1` を書いて `sam deploy`（P4 の SMTP の Secret の後。0 のままなら `chatwoot-prod:ecs` で止まる）— cloud 4.11
- [ ] **人・画面** `https://chat.comegin.com` の onboarding で最初の管理者とアカウントを作る → 管理者のトークンを `CHATWOOT_ADMIN_TOKEN`、アカウント ID を `CHATWOOT_ACCOUNT_ID` に — manual 8.3
- [ ] **人・画面** エージェント専用ユーザー（担当者の権限）を招待してログインし、トークンを `CHATWOOT_AGENT_TOKEN` に（P10 と共用。ADR-17）— manual 8.3
- [ ] **人・端末** 出力 `FaqBotFunctionUrl` ＋ `webhook` を `FAQ_BOT_WEBHOOK_URL`、本番の公開サイトの URL を `PUBLIC_SITE_URL` に書いて再実行 → **自動**（受信箱・ラベル・FAQ ボット・マクロ・通知）
- [ ] **人・端末** FAQ ボットの access_token と secret を Secrets Manager に入れる（表示されたコマンド）→ **〔申告〕** `FAQ_BOT_SECRETS_STORED=<指紋>` — manual 8.3・cloud 4.17

### P8. Mautic（`mautic-prod`）

止まる id は `mautic-prod:ecs-web`・`mautic-prod:settings`・`mautic-prod:ecs-cron`。

- [ ] **人・端末** `MauticWebDesiredCount=1` を書いて `sam deploy`（cron はまだ 0 のまま。0 なら `ecs-web` で止まる）— cloud 4.11
- [ ] **人・画面** `https://mkt.comegin.com/installer` でインストールする（管理者のパスワードは自分で決めて控える）— cloud 4.10
- [ ] **人・画面** 画面で設定する: API の有効化・Webhook のキューモード `command_process`・私設アドレスの許可は **`10.99.0.2` だけ**・自動停止は無効にしない・CORS は本番の公開サイトのオリジンだけ・メール（SES の SMTP）・Site URL が `https://` か — cloud 4.10・manual 8.4
- [ ] **人・画面** 初期設定用の API 認証情報を作り `MAUTIC_SETUP_CLIENT_*` に → **〔申告〕** `MAUTIC_PROD_SETTINGS_DONE=yes` → 再実行で **自動**（項目・フォーム consult・自動返信・セグメント mql）— manual 8.4
- [ ] **人・端末** 初期設定の後に `MauticCronDesiredCount=1` を書いて `sam deploy`（**1 に固定**。2 つ動くとメールが二重になる。1 でなければ `ecs-cron` で止まる）— cloud 4.11

### P9. 本番の n8n（`n8n-prod`）

本番の n8n のオーナー・公開 API のキー・MCP のトークンを作り、provision（資格情報・ワークフロー・Mautic と Chatwoot の Webhook。送り先 `http://10.99.0.2:5680/webhook/...`）を行う。止まる id は `n8n-prod:mautic-api-credentials`・`n8n-prod:chatwoot-admin-token`・`n8n-prod:aws-key`。

- [ ] **人・画面** 本番の Mautic で **n8n 用の** API 認証情報を作り、`N8N_MAUTIC_CLIENT_*` に（ほかの用途と同じ値は失敗にする）— manual 8.6
- [ ] **人・端末** `CHATWOOT_ADMIN_TOKEN`（P7 と同じ）と、任意で棚卸し専用の `CHATWOOT_N8N_API_TOKEN` を書く — manual 8.6
- [ ] **人・端末** P6 で発行した `onprem-n8n-sns` のキーを `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` に（スクリプトがそのユーザーのキーかを確かめる）— manual 8.6
- 再実行で **自動**（オーナー・API キー・MCP のトークン・provision。SNS のトピックはスタックの出力から。子だけ公開）
- [ ] **判断** 親（I-11・I-12）の公開は R1 が決める（`N8N_PUBLISH_PARENTS=true` を書いて再実行）
- [ ] 〔警告〕**人・画面** ハートビートを有効にする: n8n の `ops_settings` の `heartbeatEnabled` を `true` にしてワークフローを公開 → アラーム `onprem-n8n-schedule-heartbeat` が OK に戻るのを確かめる — cloud 4.10「ハートビート」
- [ ] 〔未検査〕**人・画面** Mautic・Chatwoot の管理画面から Webhook を試し送信し、オンプレの n8n に届くことを確かめる — cloud 4.13「WireGuard」・onprem「疎通の確かめ方」

### P10. 本番の MCP（`mcp-prod`）

止まる id は `mcp-prod:prod-values`・`mcp-prod:finish`。

- [ ] **人・画面** エージェント専用のアカウントでトークンを発行して `prod.conf` に書く: `CHATWOOT_AGENT_TOKEN`（P7）・`MAUTIC_CLIENT_*` と `MAUTIC_RO_CLIENT_*`（別々に 2 つ）・`STRAPI_PROD_TOKEN`・`POSTHOG_PROD_API_KEY`（`phx_`）と `POSTHOG_PROD_PROJECT_ID`（`N8N_PROD_TOKEN` は P9 が状態に置くので書かなくてよい）— manual 8.2
- [ ] **人・端末** 承認済みの `main` のチェックアウトで `pnpm install && pnpm build`（本番の MCP はそこの `dist` で動く）— manual 8.2
- 再実行で **自動**（env ファイル 6 つ・読み取りだけの確認）

### P11. 公開サイトの値（`node setup/frontend.mjs --target prod`）

止まる id は `verdant-virgo:prod-values`。

- [ ] **人・端末** `prod.conf` に `SITE_BUILD_CHECKOUT`（承認済みの main のチェックアウト。作業ツリーは不可）・`PUBLIC_SITE_URL`・`SITE_STRAPI_API_TOKEN`（P6）・`UPLOAD_S3_BUCKET`・`SITE_POSTHOG_PROJECT_TOKEN` を書く — setup「フロントエンド全体」
- 再実行で **自動**（`.env.production` を書く。測定 ID は空＝タグを出さない）

### P12. ビルドと配信〔未検査〕

- [ ] **人・端末** 承認済みの main のチェックアウトで公開サイトをビルドする（`SITE_URL` 未設定のビルドは意図して止まる）
- [ ] **人・端末** `DeployPolicyArn` を付けた主体で、S3 へ同期 → CloudFront を無効化（**この順を入れ替えない**）— cloud 4.14
- [ ] **人・端末** デプロイ後の確認（訪問者向けは 200、管理画面は 302 で `auth.`、許可リストの外は 404、`cms.`・`n8n.`・`stats.` は引けない）— cloud 4.13
- [ ] **人・画面** FAQ ボットの確認（`/faq.json` が返る・「料金は税込ですか？」で回答・担当者への引き継ぎのメール）— cloud 4.17 の 8
- [ ] 〔警告〕**人・画面** 配信したらすぐ、SES の**本番アクセスを申請する**（メールの種類は **Transactional**、言語は日本語。2026-10-28 のユーザーの決定。最初の応答まで最大 96 時間で、承認までは検証済みの宛先にしか送れない）— cloud 4.9.2

### P13. 段階 `google`（公開サイトが Route 53 から配信された後）

```bash
node setup/setup.mjs --target prod --phase google
node setup/frontend.mjs --target prod --phase google
```

- [ ] **人・画面** GA4 の本番のプロパティと Web ストリームを作り、`GA4_PROPERTY_ID`・`GA4_MEASUREMENT_ID` に（`ga4:property`）— manual 7.5
- [ ] **人・画面** Search Console にドメインプロパティ `comegin.com` を登録し、Route 53 に TXT を足す（`verdant-virgo:gsc-domain`）— manual 7.4
- [ ] **人・画面** OpenSEO 用の OAuth クライアント（Search Console API・Analytics Admin API・Data API を有効に。リダイレクト URI 2 つ）→ `OPENSEO_GOOGLE_CLIENT_*` — manual 7.4・7.5
- [ ] **人・画面** `http://localhost:3001` で Search Console と GA4 に接続 → **〔申告〕** `OPENSEO_GSC_CONNECTED=yes`・`OPENSEO_GA4_CONNECTED=yes` — manual 7.4・7.5
- [ ] **人・端末** 測定 ID 入りでビルドし直して、P12 と同じ手順で配信する

### P14. 運用開始の仕上げ〔未検査〕

- [ ] **人・画面** ほかの担当者を Chatwoot の受信箱「Web サイト」のメンバーにし、各自のプロフィールで「新しい会話が作成されたとき」のメール通知を有効にする — cloud 4.17 の 7
- [ ] **人・端末** 初期設定が終わったら、`prod.conf` から `CHATWOOT_ADMIN_TOKEN` と `MAUTIC_SETUP_CLIENT_*` を消し、Mautic の初期設定用の API 認証情報を画面で消す — manual 8.3・8.4
- [ ] **人・端末** 監視アプリのハートビート（`onprem-heartbeat`）が OK であることを確かめる — cloud 4.13
- [ ] **判断** [6 節](#6-判断が残っている項目r1)の項目

## 4. 設定スクリプトが確かめる範囲

以前はどれもスクリプトが確かめず、抜けると後の段階で別の名前のエラーとして現れていた（右の列）。2026-10-28 から、読み取りで確かめられるものは確かめる。

| 手順 | 今のスクリプト | 抜けたときの見え方 | 詳細 |
|---|---|---|---|
| DB とアプリ用ユーザーの作成（db-init） | **止める**（`cloud:db-init`。タスクのログ） | admin-auth の migrate の失敗・Strapi の `password authentication failed`・Chatwoot の移行の失敗 | cloud 4.8 |
| Chatwoot の DesiredCount | **止める**（`chatwoot-prod:ecs`） | `chatwoot-prod` が本番の Chatwoot に届かない | cloud 4.11 |
| Mautic の DesiredCount（web → インストール → cron） | **止める**（`mautic-prod:ecs-web`・`ecs-cron`） | `/installer` が開かない／キャンペーンとメールが動かない | cloud 4.10・4.11 |
| 本番の n8n の provision | **行う**（`n8n-prod`） | Webhook が n8n に届かない | manual 8.6 |
| SNS 用の IAM のキーがそのユーザーのものか | **止める**（`n8n-prod:aws-key`） | 通知とハートビートが失敗する／強い権限のキーが n8n に入る | cloud 4.5 |
| global の 2 回目（フラットレートプラン） | 警告（`cloud`） | 何も起きない（CloudFront が従量課金のまま。月 約 $9 増える） | cloud 4.3 |
| SNS の購読（`--authenticate-on-unsubscribe` 付きか） | 警告（`cloud`） | アラームが誰にも届かない／誰でも購読を解除できる | cloud 4.4 |
| SES の本番アクセス・DKIM・MAIL FROM・DMARC | 警告（`cloud`） | 顧客にメールが届かない | cloud 4.9 |
| バウンス・苦情の Mautic への反映（ADR-30） | 未実装（実装まで SES の抑制リストが送信を止める） | Mautic のコンタクトの状態が実際と食い違う | cloud 4.9.2 |
| SMTP の Secret | 警告（`cloud`） | Chatwoot・Mautic のタスクが起動しない | cloud 4.6 |
| WireGuard の AMI の固定 | 警告（`cloud`） | 後のデプロイで EC2 が置き換わり、鍵が変わってトンネルが切れる | cloud 4.2.1 |
| オンプレの IAM ユーザーのアクセスキー | 警告（`cloud`） | Strapi のメディアのアップロードと n8n の通知が失敗する | cloud 4.5 |
| n8n のハートビート | 警告（`n8n-prod`。アラームの状態） | n8n が止まっても気づけない | cloud 4.10 |
| `db:chatwoot_prepare` | 確かめない（`chatwoot-prod:ecs` の案内に出る） | Chatwoot が 500 を返す | cloud 4.10 |
| Strapi の最初の管理者とトークン | 確かめない（足りないと `mcp-prod:prod-values`・`verdant-virgo:prod-values` で止まる） | 同左 | manual 8.2 |
| Webhook の試し送信 | 確かめない | Mautic・Chatwoot のイベントが欠ける | onprem「疎通の確かめ方」 |
| 公開サイトのビルドと配信 | 確かめない | `--phase google` の所有権の確認が通らない・FAQ ボットが答えない | cloud 4.14 |

## 5. 申告制のフラグ（`prod.conf`）

設定や状態が製品の DB や EFS の中にあり、外から読み取りだけでは確かめられないもの。**書くとスクリプトは確かめずに先へ進む。**

| フラグ | 書いてよい状態 | 詳細 |
|---|---|---|
| `ADMIN_AUTH_PROD_READY=yes` | migrate と register-alb-client が `{"ok":true}` で、Google でログインして戻れた | manual 8.1 |
| `FAQ_BOT_SECRETS_STORED=<指紋>` | FAQ ボットの 2 つの値を Secrets Manager に入れた（ボットを作り直したら入れ直す） | manual 8.3 |
| `MAUTIC_PROD_SETTINGS_DONE=yes` | インストールと画面の設定（API・Webhook・CORS・メール）が済んだ | manual 8.4 |
| `OPENSEO_GSC_CONNECTED=yes` | OpenSEO で Search Console に接続し、プロパティを選んだ | manual 7.4 |
| `OPENSEO_GA4_CONNECTED=yes` | OpenSEO で本番の GA4 プロパティに接続した | manual 7.5 |

## 6. 判断が残っている項目（R1）

既定のまま動く。決めたら `samconfig.toml` などに書いてデプロイする。

| 項目 | 今の既定 | 判断の材料 | 詳細 |
|---|---|---|---|
| **DB をサーバーレスのままにするか、クラスター（プロビジョンド）にするか** | Aurora Serverless v2（MySQL・PostgreSQL とも。最小 0.5・最大 2 ACU） | 下の「DB のコストの比較」 | cloud 6 |
| WAF の Common ルールを Count から Block に | Count | WAF のログで管理画面の保存・アップロードが Count に入っていないか | cloud 4.16 |
| n8n の親（I-11・I-12）の公開 | 未公開 | 受け口の疎通と署名の検証を確かめたか | provision README |
| SES の TLS を必須のままにするか | `REQUIRE` | TLS で受けられない宛先が業務に要るか | cloud 4.9 |
| バウンス・苦情を Mautic に返す Lambda（ADR-30）をいつ作るか | 設計だけ決定済み・未実装 | 顧客へのキャンペーンの送信を始める時期（その前が望ましい） | AA-05 の ADR-30 |
| SES の Mail type を Marketing に改めるか | Transactional（2026-10-28 のユーザーの決定） | Mautic のキャンペーンの一斉送信が大半になったか | cloud 4.9.2 |
| 費用を下げる手段（Savings Plans・Fargate の ARM・mautic-cron の縮小・夜間の停止の時刻） | どれも未適用（夜間の停止だけ有効） | 1〜2 か月の実績 | cloud 3.1 |
| 公開サイトの CSP をどこで付けるか | 付けていない | CloudFront の応答ヘッダーか Astro か | cloud 5 |

### DB のコストの比較（後で判断する）

方針は「アプリケーション側に互換がある場合はサーバーレス、それ以外はクラスター。サーバーレスとクラスターでコストを比較し、後で判断する」。
単価は AWS の Pricing API の東京（`ap-northeast-1`）の値（2026-10-28 に取得。公表は 2026-10-26。月 730 時間）。1 クラスターあたり、ストレージと I/O を除く。

| 構成 | 単価 | 月額 | 向いている使われ方 |
|---|---|---:|---|
| Serverless v2・平均 0.5 ACU（今の最小） | $0.15/ACU 時 | $55 | 夜や休日に負荷がほぼ無い |
| Serverless v2・平均 1 ACU | 同上 | $110 | |
| Serverless v2・平均 2 ACU（今の上限） | 同上 | $219 | |
| クラスター・db.t4g.medium × 1 | $0.113/時 | $82 | 平均 0.75 ACU 以上で常に動く（CPU クレジットを超えると $0.09/vCPU 時が加わる） |

- **損益分岐は平均 0.75 ACU**（$0.113 ÷ $0.15）。これを超え続けるならクラスターのほうが安い。
- どちらのエンジンもサーバーレスに互換がある（Mautic は MySQL、Chatwoot・admin-auth・Strapi・n8n は PostgreSQL。2026-10-27 に東京で `db.serverless` を確認済み）。Valkey だけはサーバーレスに互換が無く（Chatwoot の Sidekiq が Redis Cluster に対応しない）、ノード 1 つ（cache.t4g.micro）にしてある。
- **判断のしかた**: 1〜2 か月動かした後、Cost Explorer の使用タイプ `Aurora:ServerlessV2Usage` と、CloudWatch の `ServerlessDatabaseCapacity`（ACU の実数）の月平均を見る（`ACUUtilization` は最大 ACU に対する % なので、2 ACU 上限なら 37.5% が 0.75 ACU）。平均が 0.75 ACU を超え続けていたら、そのクラスターだけプロビジョンドに切り替える（`cloud/stacks/data.yaml` の `DBInstanceClass: db.serverless` を直す。パラメータは無いのでテンプレートの変更になり、インスタンスの置き換えで短く止まる）。

## 7. 置き場所の方針（確認用）

| 置き場所 | もの | 理由 |
|---|---|---|
| **オンプレ** | 再帰的自己改善の仕組み: Strapi・n8n（本番）、監視アプリ（next-js ＋ control-plane）、MCP サーバ、OpenSEO、公開サイトのビルド | ADR-21 |
| **クラウド（計算）** | 成果物（正本を持つシステム）: Mautic・Chatwoot は ECS on Fargate、自作の consent-api・admin-auth・faq-bot は Lambda、Astro は S3 ＋ CloudFront | ADR-21・ADR-26 |
| **クラウド（データの置き場）** | Aurora（MySQL・PostgreSQL）・ElastiCache（Valkey）・S3・EFS。オンプレの Strapi・n8n も RDS と S3 を使う | ADR-21 |
| 例外 | WireGuard の終端だけ EC2（t4g.nano）。Fargate はカーネルのモジュールと `NET_ADMIN` を持てず、Lambda は常駐できないため | cloud 6 |
