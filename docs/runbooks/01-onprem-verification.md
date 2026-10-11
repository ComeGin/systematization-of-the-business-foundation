# オンプレミスでの動作確認 手順書

2026-10-04〜05 に作ったバックエンド（Wave 0〜3 と ADR-21 の見直し）を、オンプレミスで動かして確かめるための手順。台帳の Wave 4 の確認項目（`.superpowers/teams/2026-10-04-backend/tasks.md`）のうち、オンプレミスで確かめられるものを順番に並べた。

パスはリポジトリのルートからの相対で書く。

> **近道（2026-10-05）: フェーズ A の環境の用意（各製品の起動・管理者・トークン・MCP の env ファイル・n8n の取り込み）は、[`setup/`](../../setup/README.md) の `node setup/setup.mjs --target dev` が 1 本で行う。** 止まったら案内に従い、同じコマンドを実行し直す。以下の A1〜A7 は、スクリプトが何をしているかを知りたいとき、スクリプトが失敗したとき、動作の確認（curl・監視アプリからの起動）を行うときに読む。

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
- 開発環境の中継（`middleware/host-relay`。コンテナの n8n・Chatwoot から、ホストの `127.0.0.1` の Mautic・MailHog・n8n に届くようにする）を起動する（2026-10-05 に起動済み）
- Chatwoot（`docker compose run --rm rails bundle exec rails db:chatwoot_prepare` → `docker compose up -d`）・n8n（`middleware/n8n`）・Mautic（`backend/mautic-system/dev/serve.sh`）・Strapi（`backend/strapi-system` で `pnpm dev`）を起動し、ヘルスを確かめる

**合格**: Chatwoot `127.0.0.1:3100`・n8n `127.0.0.1:5678`・Mautic `127.0.0.1:8000`・Strapi `127.0.0.1:1337` が応答する。MailHog `127.0.0.1:8025` が開く。

### A1b. GA4・OpenSEO（開発では Google の手順を飛ばす。2026-10-06。ADR-25）

> **（2026-10-06）ADR-25（AA-05）で Umami を廃止した。** 旧版のこの節は「A1b. Umami（開発環境。`middleware/umami`）」で、自作の compose の起動・`node setup/setup.mjs --target dev --only umami`・`127.0.0.1:3000` のバインドと `/mcp` の 401 の確認を行っていた。**Umami の確認手順はすべて外した。** `middleware/umami`・`middleware/umami-master` はリポジトリから消え、ポート 3000 は空きになった。流入・ページ・参照元の正本は **GA4**（SaaS）で、エージェントは **OpenSEO の MCP（`127.0.0.1:3001`。登録名 `openseo`）の GA4 のツール**で読む。設定値の記録は `middleware/ga4/README.md`。

**Umami の後片付け（ADR-25 で廃止した分。あなたの作業。Claude は消さない）**
- Docker のボリューム **`umami_db-data`・`umami_umami-db-data`・`umami-master_umami-db-data`** は残してある（コンテナは `-v` なしで止め済み）。要らなければ `docker volume rm` で消す
- `~/.config/comegin/setup/dev.state.json` の `UMAMI_*` のキーと、`~/.config/comegin/mcp/umami-dev.env` は残してある。要らなければ消す。Claude Code の MCP の登録に `umami`・`umami-prod` が残っていれば外す

**開発環境で確かめること（2026-10-06 の変更。Google の手順は開発では飛ばす）**
- 開発の時点では公開サイトが AWS に展開されておらず、Search Console にも GA4 にもデータが無いので、**`--target dev` は Google（OAuth クライアント・Search Console・GA4 のプロパティ・OpenSEO の GA4 の接続）の手順を飛ばす**。これらは AWS に展開した後に B7 で行う

**Claude の作業**
- `node setup/setup.mjs --target dev --check --only ga4,openseo` が通る（開発の Astro の環境変数に `PUBLIC_GA4_MEASUREMENT_ID` が無い、OpenSEO の health が ok で DataForSEO が ok。Google の接続は求めない）

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

手順の正本は `middleware/n8n/workflows/README.md` の「開発の n8n で動かす前の準備」。**下の「あなたの作業」の大半は、`middleware/n8n/provision` のスクリプト（`node provision.mjs --target dev`）で自動にできる**（手順は `middleware/n8n/provision/README.md`）。スクリプトを使う場合、あなたの作業は「n8n の管理者と API キーの作成」「Mautic の API 資格情報と Chatwoot の管理者のトークンを設定ファイルに書く」「実行する」だけになる。以下は手で行う場合の手順。

**あなたの作業（手で行う場合）**
- [ ] Data Table を 5 つ作り（`dedup_mautic` `dedup_chatwoot` `ops_settings` `monitor_state` `contact_link`）、`ops_settings` に行を入れる（`notifyBackend=mailhog`、`mauticBaseUrl=http://host.docker.internal:8000`）
- [ ] JSON 5 本を取り込み、`I-11`・`I-12` の「I-21 通知を呼ぶ」「I-19 突合を呼ぶ」ノードで呼び先を選び直す
- [ ] 資格情報を 4 つ作る: `MailHog SMTP（開発）`、`Mautic API（client_credentials）`、`Mautic Webhook 署名鍵（Crypto）`、`Chatwoot Webhook 署名鍵（Crypto）`（署名鍵は Hmac Secret を必ず入れる）
- [ ] Mautic と Chatwoot の管理画面で、Webhook の送信先を Mautic は `http://127.0.0.1:5678/webhook/mautic-event`、Chatwoot は `http://host.docker.internal:5678/webhook/chatwoot-event` にし、シークレットに上の署名鍵と同じ値を入れる（手順の詳細は `middleware/n8n/workflows/GUIDE.md`）
- [ ] `I-11`・`I-12` を**短時間だけ公開（publish）**する（確認が終わったら戻す）

**Claude の作業**
- README の curl で、署名の 3 通り（正しい署名 → 200、誤った署名 → 401、署名なし → 401）と、Chatwoot の古いタイムスタンプ → 401 を確かめる
- 同じ本文を 2 回送り、2 回目が重複として処理されないことを確かめる
- MailHog に通知メール（個人情報を含まない）が届くことを確かめる

**合格**: 上の 3 つがすべて期待どおり。終わったら公開を戻す。

### A5b. n8n（開発環境）の新しい 3 本（2026-10-06。ADR-21 の整理）

`weekly-inquiry-inventory`（週次の棚卸し）・`n8n-schedule-heartbeat`（ハートビート）・`ops-monitor`（OpenSEO の死活とサンドボックスの証明書の期限。**開発環境だけ**）。**どれも未公開で、`ops_settings` のスイッチ（`inventoryEnabled`・`heartbeatEnabled`・`opsMonitorEnabled`）が既定で `false`**。確認の間だけ公開・有効化し、終わったら戻す。**flow の報告（`reports/flow.md`）で、`test_workflow` による確認は済んでいる。ここでは、公開した状態の実機での確認を行う。**

**あなたの作業**
- [ ] `node setup/setup.mjs --target dev --only n8n` で取り込む（provision。公開はされない）。Chatwoot の棚卸し用のトークン（`CHATWOOT_N8N_API_TOKEN`。空なら管理者のトークンで代用される）を設定に入れる
- [ ] 確認する 1 本だけ公開し、対応するスイッチの行を `true` にする（`ops_settings`）

**Claude の作業**
- 棚卸し: 未割り当ての会話を Chatwoot に 1 件作ってから手動で実行し、MailHog に通知メール（会話番号と件数だけ。氏名・本文・email が無いこと）が届くこと。**0 件のときは通知されない**こと
- `ops-monitor`: 実行して通知が出ない（`ok`）こと → OpenSEO を止めて（`docker compose stop`）もう一度実行し、**1 回だけ**通知が出ること → 起動し直して `ok` に戻ると 1 回だけ通知が出ること。`/api/health` の中継は `docker exec n8n-n8n-1 wget -qO- http://host.docker.internal:3001/api/health`（200）と、それ以外のパスが 404 であること
- ハートビート: **AWS を呼ばない確認**にとどめる（署名の組み立てとローカルのエコーサーバー。実機の送信は AWS のデプロイ後。B5）

**合格**: 上のとおり。終わったら公開を戻し、スイッチを `false` に戻す。

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

**あなたの作業（続き。再送と送信先の確認。2026-10-06 に追加）**
- [ ] Mautic・Chatwoot の管理画面で、Webhook の送信先に **プライベートアドレス（`10.99.0.2`）の `http://` を保存できるか**を確かめる（製品によっては送信先のアドレスを検査して拒否する。AA-02 の 5 節の未確認の点）。拒否されたら、そこで止めて報告する
- [ ] 受け口を**わざと止めた状態**（`docker compose stop webhook-proxy` など）で、テストのコンタクトのフォーム送信を 1 回行い、**Mautic・Chatwoot が失敗した Webhook を再送するか**（回数・間隔・諦めた後に記録が残るか）を見る。確かめたら受け口を戻し、再送が届いたときに重複排除（`dedup_*`）が働くことも見る（DD-04 の 11 節・DD-07 の 2.5）

**合格（続き）**: 送信先が保存できる。再送の有無が分かり、DD-04 の 11 節・DD-07 の 2.5 の「未確認」を書き換えられる。

### B5. n8n のハートビートとアラーム（AWS のデプロイ後。2026-10-06 に追加）

**前提**: SAM のデプロイが済み（`observability`・`iam` を含む）、オンプレの n8n に IAM ユーザー `comegin-<env>-onprem-n8n-sns` のアクセスキーが資格情報として入っていること。**デプロイは別途の指示があるまで行わない。**

**あなたの作業**
- [ ] 本番の n8n で `n8n-schedule-heartbeat` を公開し、`ops_settings` の `heartbeatEnabled` を `true` にする（**公開は `R1` の判断**）
- [ ] 監視アプリの `heartbeat`（`ops/schedules/heartbeat.yaml`。`enabled: false`）を有効にするかを判断する

**Claude の作業**
- CloudWatch に名前空間 `ComeGin/OnpremN8n`・メトリクス `ScheduleHeartbeat` が 5 分ごとに届くこと（ディメンションなし。綴りの違いは `AccessDenied`）。n8n の実行履歴に失敗が無いこと
- アラーム `comegin-<env>-onprem-n8n-schedule-heartbeat` が OK になること。次に `heartbeatEnabled` を `false` にして（または n8n を止めて）15 分待ち、**ALARM になって ops に通知が届くこと**、戻すと OK の通知が届くこと
- **止めたのが n8n だけか全体か**は、監視アプリのアラーム（`comegin-<env>-onprem-heartbeat`）と見比べて区別できること
- プロキシだけを止めても**アラームが発火しない**（検出手段が無い。DD-07 の 2.5）ことを確かめて記録する

**合格**: 欠損で ALARM、復旧で OK に戻り、通知が届く。**確かめられないこと**: n8n の HTTP Request ノードの署名が通るかは、ここで初めて分かる（flow の確認事項）。

### B6. ワークフローの書き出し（`n8n-export`。2026-10-06 に追加）

**あなたの作業**
- [ ] 本番の n8n の版を確かめる。**コミュニティ版なら API キーは全権限になる**（`workflow:list`・`workflow:read` に絞れない）。その資格情報を監視アプリの環境変数に置いてよいかを判断する（TA-03 の 6 節・TA-04 の 9 節）
- [ ] 本番の n8n で API キーを発行し、`frontend/next-js` の環境変数ファイルに `CONTROL_N8N_EXPORT_URL`（例 `http://127.0.0.1:5679`）・`CONTROL_N8N_EXPORT_API_KEY` を入れる（GitHub の資格情報は `I-13` と同じ）

**Claude の作業**
- 監視アプリから `daily-n8n-export` を**手動で 2 回**起動する。1 回目は差分があれば `chore/n8n-export-YYYYMMDD` のブランチに PR ができる（確認後に閉じる。テスト用のリポジトリで試せるならそちらを使う）（**初回は既存 5 本にキー順だけの再整形の差分が出る**）。**2 回目に差分が出ない**こと（出たら除去するフィールドの初期値を見直す。TA-03 の 6 節）
- PR の差分に秘密値が無いこと。秘密値の疑いのあるワークフローは PR から外され、`E-15` の要約に名前だけが出ること。作業ツリーが書き換わっていないこと

**合格**: 2 回目が差分なしで `success`。PR は確認後に閉じる。

---

### B7. GA4 と Search Console の接続（AWS に展開した後。2026-10-06 に A1b から移した。ADR-25）

開発環境（`--target dev`）では Google の手順を飛ばす（A1b）。公開サイトを AWS に展開してから、`node setup/setup.mjs --target prod --only ga4,openseo` で行う。OpenSEO はオンプレのローカルに 1 つだけで、開発と本番のエージェントが同じものを使う。値は `~/.config/comegin/setup/prod.conf` に書く。Search Console の OAuth クライアントと接続（`openseo:google-oauth-client`・`openseo:gsc-connect`）も同じ実行で案内される（`setup/manual-steps.md` の 7.4）。

**あなたの作業（GA4 のプロパティ。本番の 1 つだけ）**
- [ ] GA4 で本番のプロパティを作る（タイムゾーン `Asia/Tokyo`・通貨 `JPY`・データ保持 14 か月・Google シグナル オフ・広告のリンクなし・ユーザー提供データの収集 オフ）。Web のデータストリームを作り、測定 ID（`G-…`）を得る
- [ ] プロパティ ID（数字）と測定 ID を `~/.config/comegin/setup/prod.conf` の `GA4_PROPERTY_ID`・`GA4_MEASUREMENT_ID` に書く（どちらも秘密値ではない）。**開発の Astro の環境変数（`PUBLIC_GA4_MEASUREMENT_ID`）には書かない**（開発環境ではタグを出さない）

**あなたの作業（OpenSEO に GA4 を接続する。GSC と同じ OAuth クライアント）**
- [ ] Google Cloud（GSC の OAuth クライアントと同じプロジェクト）で **Google Analytics Admin API** と **Google Analytics Data API** を有効にする
- [ ] 同じ OAuth クライアント（Web アプリケーション）の承認済みのリダイレクト URI に **`http://localhost:3001/api/ga4/oauth/callback`** を足す（GSC の `/api/gsc/oauth/callback` は残す）
- [ ] OpenSEO の画面（`http://localhost:3001`）の `comegin.com` のプロジェクトで、**Project settings → Analytics の Connect with Google** を押し、Analytics の読み取り専用の許可を与えて、**本番のプロパティだけ**を選ぶ（GSC とは別に同意が 1 回要る）
- [ ] 済んだら `prod.conf` に `OPENSEO_GA4_CONNECTED=yes` を書く（GA4 を接続しないと決めたら `OPENSEO_SKIP_GA4=yes`。その場合 `analytics-reporter` は GA4 を読めない）

出典: `middleware/open-seo-main/docs/SELF_HOSTING_GOOGLE_ANALYTICS.md`（API の有効化・リダイレクト URI・Connect with Google・トークンは Better Auth の account テーブルに暗号化して保存）、`middleware/open-seo-main/specs/0007-google-analytics-mcp-integration.md`（スコープは `analytics.readonly`）。

**Claude の作業**
- `node setup/setup.mjs --target prod --check --only ga4,openseo` が通る（`GA4_PROPERTY_ID` が数字、`GA4_MEASUREMENT_ID` が `^G-[A-Z0-9]+$`、`OPENSEO_GSC_CONNECTED` か `OPENSEO_SKIP_GSC`、`OPENSEO_GA4_CONNECTED` か `OPENSEO_SKIP_GA4` がある）
- Claude Code から `mcp__openseo__get_google_analytics_measurement_health` を `comegin.com` のプロジェクトで呼び、**接続済み（`not_connected` でない）**ことと、選んだのが本番のプロパティであることを確かめる（無料。費用の出るツールは呼ばない）
- `I-05`（本番のタグ）が通るまではデータが無いのが正常（`empty_but_ok`。DD-03 の 5.2）

**合格**: `--check` が通り、`get_google_analytics_measurement_health` が接続済みを返す。**確かめていない点**（2026-10-06 の時点）: 本番のタグを置いた後に GA4 のリアルタイム表示で同意の前に送られていないこと（DD-02 の 2 節）。`connection expired` が出たら、上の Connect with Google をやり直す（OAuth アプリが Testing のままだと更新の許可が短命になる。手順書の Troubleshooting）。

## 終わったら

- 結果を台帳（`.superpowers/teams/2026-10-04-backend/tasks.md`）の Wave 4 に記録する（Claude）
- 確認のために足した設定を戻す: 開発の n8n の公開、`WEBHOOK_ALLOWED_SOURCES`、ngrok
- 残る確認（ALB と admin-auth の実機〈PKCE・クライアント認証の方式〉、SNS の購読〈`--authenticate-on-unsubscribe`〉、クラウドの各サービスの TLS）は、クラウドのデプロイの後に行う
