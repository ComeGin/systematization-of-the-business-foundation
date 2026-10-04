# オンプレミスでの動作確認 手順書

2026-10-04〜05 に作ったバックエンド（Wave 0〜3 と ADR-21 の見直し）を、オンプレミスで動かして確かめるための手順。台帳の Wave 4 の確認項目（`.superpowers/teams/2026-10-04-backend/tasks.md`）のうち、オンプレミスで確かめられるものを順番に並べた。

パスは `MarketingDepartment/WebsiteOperations/` からの相対で書く。

## 0. 進め方

### フェーズの分け方

| フェーズ | 中身 | 前提 |
|---|---|---|
| **A** | 開発環境・新しい自作サービス・n8n のワークフロー・監視アプリ・改善ループの 1 周 | AWS は使わない。**今すぐできる** |
| **B** | 本番の Strapi・n8n（`onprem/`）と WireGuard、クラウドからの Webhook | AWS のデータ層と WireGuard の EC2 のデプロイが要る（`sam deploy` は別途の指示が要る） |

### 分担

| 作業 | 誰が |
|---|---|
| 秘密値の入力（環境変数ファイル）、外部サービスでの発行（Google・Anthropic・GitHub・AWS）、各製品の管理画面の操作、`git worktree`、`/etc` への書き込み | **あなた** |
| スタックの起動・停止、ビルド、curl での確認、ログの確認、監視アプリからのジョブの起動、結果の判定 | **Claude**（あなたが各ステップの「あなたの作業」を終えたら、「A2 まで終わった」のように声をかけてください） |

Claude は `.env` などの秘匿ファイルを読めない（フックで止まる）。値が要る確認は、あなたが入れた後に、起動の結果やログで判定する。

### 共通の注意

- **開発用の n8n の ngrok は、フェーズ A の間は閉じておく。** Webhook の署名の検証を実地で確かめる前に公開しない。
- 秘密値をシェルの履歴に残さない（`export` を打たず、環境変数ファイルに書く）。

---

## フェーズ A（AWS を使わない）

### A1. 開発用のスタックを起動する

**あなたの作業**
- [ ] `backend/chatwoot-system/docker-compose.yaml` の `image: chatwoot/chatwoot:latest` を、**4.12 以上の固定のタグ**（例 `chatwoot/chatwoot:v4.18.0`）にする（4.12 より前は Webhook に署名が付かず、`I-12` が常に 401 になる）。初めての版にするときは、DB の移行が要る（下の Claude の作業）
- [ ] Mautic・Chatwoot・n8n の開発用の環境変数ファイルが無ければ、各 `dev/init-env.sh` を実行する

**Claude の作業**
- Chatwoot（`docker compose run --rm rails bundle exec rails db:chatwoot_prepare` → `docker compose up -d`）・n8n（`middleware/n8n`）・Mautic（`backend/mautic-system/dev/serve.sh`）・Strapi（`backend/strapi-system` で `pnpm dev`）を起動し、ヘルスを確かめる

**合格**: Chatwoot `127.0.0.1:3100`・n8n `127.0.0.1:5678`・Mautic `127.0.0.1:8000`・Strapi `127.0.0.1:1337` が応答する。MailHog `127.0.0.1:8025` が開く。

### A2. consent-api（Cookie 同意の受け口）

**あなたの作業**
- [ ] `backend/consent-api/.env.example` を写して環境変数ファイルを作る（名前は `.env.example` の冒頭のコメントのとおり）。`SITE_URL=http://localhost:4321`、`COOKIE_DOMAIN` は空、`CONSENT_POLICY_VERSION` は文面の版（例 `2026-10-01`）

**Claude の作業**
- `docker compose up -d --build` → `README.md` の確認（Cookie の属性、他オリジンの拒否、送られた識別子の無視、Valkey に追記だけされること）

**合格**: `POST /v1/consent` が 201 で `comegin_consent` の Cookie を返し、`GET` で同じ状態が返る。

### A3. admin-auth（管理画面のログイン）

**あなたの作業**
- [ ] `backend/admin-auth/dev/init-env.sh` を実行する
- [ ] （Google でのログインまで確かめる場合だけ）Google Cloud で OAuth クライアント（ユーザーの種類は「内部」）を作り、`GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`ADMIN_BOOTSTRAP_EMAILS`（自分のメール）を入れる。リダイレクト URI は `http://localhost:3103/api/auth/callback/google`

**Claude の作業**
- `docker compose up -d --build` → discovery・JWKS・`/sign-in` を確かめる。ALB のクライアント登録（`register-alb-client.js`）を 2 回実行して冪等であることを確かめる

**合格**: `/.well-known/openid-configuration` と `/api/auth/jwks` が返る（Google の値を入れた場合は、`/sign-in` から許可リストのメールでログインでき、それ以外は拒否される）。

### A4. Strapi（開発環境）の新しい型と MCP

**あなたの作業**
- [ ] Strapi の管理画面（`http://127.0.0.1:1337/admin`）で、keyword・content-plan の型が出ていることを見る
- [ ] API トークンを発行し、`~/.config/comegin/mcp/strapi-dev.env` に書く（変数名は `ops/mcp-registry.yaml` の `strapi-mcp` の `headers_from_env_file` を参照）

**Claude の作業**
- strapi-mcp で keyword・content-plan のツール名を確かめる（`ops/mcp-registry.yaml` と `.claude/agents/` のツール名との突き合わせ。L3-1 の残り）
- 記事を 1 件作って非公開化・削除し、PostHog の開発用プロジェクトに `article_unpublished` と `article_deleted`（1 件だけ）が届くことを確かめる

**合格**: ツール名が登録表・エージェント定義と一致し、PostHog にイベントが 1 件ずつ届く。

### A5. n8n（開発環境）のワークフロー

手順の正本は `middleware/n8n/workflows/README.md` の「開発の n8n で動かす前の準備」。

**あなたの作業**
- [ ] Data Table を 5 つ作り（`dedup_mautic` `dedup_chatwoot` `ops_settings` `monitor_state` `contact_link`）、`ops_settings` に行を入れる（`notifyBackend=mailhog`、`mauticBaseUrl=http://host.docker.internal:8000`）
- [ ] JSON 5 本を取り込み、`I-11`・`I-12` の「I-21 通知を呼ぶ」「I-19 突合を呼ぶ」ノードで呼び先を選び直す
- [ ] 資格情報を 4 つ作る: `MailHog SMTP（開発）`、`Mautic API（client_credentials）`、`Mautic Webhook 署名鍵（Crypto）`、`Chatwoot Webhook 署名鍵（Crypto）`（署名鍵は Hmac Secret を必ず入れる）
- [ ] Mautic と Chatwoot の管理画面で、Webhook の送信先を `<開発の n8n>/webhook/mautic-event`・`/webhook/chatwoot-event` にし、シークレットに上の署名鍵と同じ値を入れる
- [ ] `I-11`・`I-12` を**短時間だけ公開（publish）**する（確認が終わったら戻す）

**Claude の作業**
- README の curl で、署名の 3 通り（正しい署名 → 200、誤った署名 → 401、署名なし → 401）と、Chatwoot の古いタイムスタンプ → 401 を確かめる
- 同じ本文を 2 回送り、2 回目が重複として処理されないことを確かめる
- MailHog に通知メール（個人情報を含まない）が届くことを確かめる

**合格**: 上の 3 つがすべて期待どおり。終わったら公開を戻す。

### A6. 監視アプリ（control-plane ＋ Next.js）

**あなたの作業**
- [ ] 定義を読むチェックアウトを作る: `git worktree add <作業ツリーの外のパス> 13-feature-develop-backend`（**本来は承認済みの `main` を読む設計だが、今回のコードはまだ `main` に入っていないため、確認の間だけこのブランチで代わりにする**）
- [ ] そのチェックアウトの `frontend/verdant-virgo` で `pnpm install`（Lighthouse 用）
- [ ] `frontend/next-js/dev/init-env.sh` を実行し、環境変数ファイルに入れる: `CONTROL_MAIN_CHECKOUT`（上のチェックアウトの絶対パス）、`CONTROL_WORKTREE`（今の作業ツリーの絶対パス）、`CONTROL_AGENT_HOME`（例 `~/.local/share/comegin-agent-home`）、`SITE_URL`（例 `http://localhost:4321`）、`ANTHROPIC_API_KEY`（**エージェントを動かす A7 で要る。API の利用料がかかる**）。`AWS_*`・`GITHUB_*`・`MISWRITE_*` は空のまま
- [ ] MCP の env ファイルを作る: `~/.config/comegin/mcp/chatwoot-dev.env`（`CHATWOOT_BASE_URL`・`CHATWOOT_API_ACCESS_TOKEN`・`CHATWOOT_ACCOUNT_ID`）、`~/.config/comegin/mcp/mautic-dev.env`（`MAUTIC_BASE_URL`・`MAUTIC_CLIENT_ID`・`MAUTIC_CLIENT_SECRET`）

**Claude の作業**
- `backend/control-plane` で `pnpm install && pnpm build` → `frontend/next-js` で `pnpm install && pnpm dev`
- 未ログインで API が 401 になること、`127.0.0.1:3200` だけで待ち受けていることを確かめる

**あなたの作業（続き）**
- [ ] `http://127.0.0.1:3200/setup` で最初の管理者を作る

**Claude の作業（続き）**
- 監視アプリからジョブを手動で起動する: `daily-silence-check`（success）、`daily-i13-file`・`runlog-flush`（AWS・GitHub が空なので skipped）。E-15 に記録が残ることを確かめる

**合格**: ログインできる。ジョブの結果が E-15 に success / skipped で残り、skipped の理由に変数名だけが入る。

### A7. 改善ループを 1 周させる（Lighthouse → seo-auditor → proposal-writer）

**Claude の作業**
- 監視アプリから `weekly-lighthouse`（main 側のチェックアウトで `pnpm lh`、結果の JSON を作業ツリーに写す）→ エージェント `seo-auditor` → `proposal-writer` を手動で起動する
- `docs/audits/lighthouse/` に E-12、条件を満たせば `docs/proposals/` に E-13（draft）ができることを確かめる
- エージェントの実行中に、子プロセスの `/proc/<pid>/environ` に秘密値（AWS・GitHub・Better Auth）が無いこと、HOME が `CONTROL_AGENT_HOME` であることを確かめる

**あなたの作業**
- [ ] できた E-13 を読み、PR にしてよいか判断する（I-13 の自動起票は GitHub の準備が要るので、フェーズ A では人が PR を作る）

**合格**: E-12 と E-15 がそろい、E-15 の `summary` に個人情報が無い。秘密値が子プロセスに渡っていない。

---

## フェーズ B（AWS のデータ層と WireGuard が要る）

**前提**: SAM のデプロイ（`cloud/README.md` の 4 節。少なくとも network・data・secrets・iam・wireguard・observability）が済んでいること。**デプロイは別途の指示があるまで行わない。**

### B1. WireGuard

手順の正本は `onprem/wireguard/README.md`。

**あなたの作業**
- [ ] `wireguard-tools` を入れる（`sudo apt install wireguard-tools` など）
- [ ] `onprem/wireguard/dev/gen-keys.sh` で鍵を作り、表示された公開鍵を AWS に渡す（`cloud/README.md` の 4.2.1。`OnpremWireguardPublicKey` か SSM パラメータ）
- [ ] 親スタックの出力 `WireguardPublicIp` と、EC2 の公開鍵（出力 `WireguardServerPublicKeyParameterName` の SSM パラメータ）を取り出し、`onprem/wireguard/dev/render-conf.sh` で設定を作って `/etc/wireguard/wg0.conf` に置く
- [ ] `sudo systemctl enable --now wg-quick@wg0`

**Claude の作業**
- `wg show` の handshake、`ping 10.99.0.1`、RDS のエンドポイントの 5432 に届くこと（`nc -vz`）を確かめる

**合格**: handshake が更新され続け、RDS に届く。

### B2. 本番の Strapi（`onprem/strapi`、`127.0.0.1:1338`）

**あなたの作業**
- [ ] AWS 側から取り出す: DB のパスワード（Secrets Manager の `comegin/prod/strapi/DB_PASSWORD`。`cloud/README.md` の 4.8）、IAM ユーザー `comegin-prod-onprem-strapi-media` のアクセスキー（4.5 で発行）、メディアのバケット名、PostHog の本番用のトークン
- [ ] `onprem/strapi/dev/init-env.sh` を実行し、上の値を環境変数ファイルに入れる

**Claude の作業**
- `docker compose build && docker compose up -d` → `/_health` が 204、管理画面が開く、RDS に TLS（証明書の検証つき）でつながっていることをログで確かめる

**あなたの作業（続き）**
- [ ] 管理画面で管理者を作り、画像を 1 枚アップロードする

**Claude の作業（続き）**
- 画像が S3 に入り、署名付き URL で取得できることを確かめる。`strapi-prod` の API トークン（あなたが発行して `~/.config/comegin/mcp/strapi-prod.env` に書く。**公開・非公開化・削除の権限を与えない**）で、MCP のツールが下書きまでに絞られていることを確かめる

**合格**: 起動し、RDS と S3 につながる。`strapi-prod` で公開・削除のツールが使えない。

### B3. 本番の n8n（`onprem/n8n`、`127.0.0.1:5679`）と Webhook の中継（`10.99.0.2:5680`）

**あなたの作業**
- [ ] DB のパスワード（`comegin/prod/n8n/DB_PASSWORD`）を取り出し、`onprem/n8n/dev/init-env.sh` の後に環境変数ファイルに入れる。**`N8N_ENCRYPTION_KEY` は生成されたものを控え、以後変えない**

**Claude の作業**
- `docker compose build && docker compose up -d` → エディターが `127.0.0.1:5679` だけ、中継が `10.99.0.2:5680` だけで待ち受けていることを確かめる。中継の境界（`onprem/README.md` の「疎通の確かめ方」。確かめる間だけ `WEBHOOK_ALLOWED_SOURCES` にブリッジを足し、**終わったら `10.99.0.1` に戻す**）

**あなたの作業（続き）**
- [ ] 本番の n8n にワークフローを取り込み、資格情報（Mautic の API・署名鍵 2 つ・SNS 用の IAM ユーザー `comegin-prod-onprem-n8n-sns` のアクセスキー）を作る。`ops_settings` は `notifyBackend=sns` と SNS のトピックの ARN

**合格**: n8n が RDS につながり、中継が `/webhook/*` の POST だけを通す。

### B4. クラウドからオンプレへの Webhook（`I-11` `I-12`）

**あなたの作業**
- [ ] クラウドの Mautic・Chatwoot の管理画面で、Webhook の送信先を `http://10.99.0.2:5680/webhook/mautic-event`・`/webhook/chatwoot-event` にする
- [ ] 本番の n8n で `I-11`・`I-12` を公開する（**本番の有効化は `R1` の判断**）

**Claude の作業**
- `docker compose logs webhook-proxy` で、**送信元が `10.99.0.1`** の要求が記録されることを確かめる（違うと本番の Webhook がすべて 404 になる）
- テストのコンタクト・会話で Webhook を起こし、重複排除と SNS の通知（個人情報なし）を確かめる

**合格**: クラウドの Mautic・Chatwoot の Webhook が、オンプレの n8n で処理される。

---

## 終わったら

- 結果を台帳（`.superpowers/teams/2026-10-04-backend/tasks.md`）の Wave 4 に記録する（Claude）
- 確認のために足した設定を戻す: 開発の n8n の公開、`WEBHOOK_ALLOWED_SOURCES`、ngrok
- 残る確認（ALB と admin-auth の実機〈PKCE・クライアント認証の方式〉、SNS の購読〈`--authenticate-on-unsubscribe`〉、クラウドの各サービスの TLS）は、クラウドのデプロイの後に行う
