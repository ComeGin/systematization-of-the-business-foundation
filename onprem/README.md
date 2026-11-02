# onprem（オンプレの本番 Strapi・n8n・WireGuard と、改善ループの本番の設定手順）

ADR-21（`docs/RequirementDefinition/AA/05-application-decisions.md`）に従い、**再帰的自己改善の仕組みである Strapi と n8n の本番をオンプレで動かし、データは AWS（RDS・S3）に置く**ためのモジュール。**オンプレの本番の設定の手順はこの README にまとめる**（2026-11-02。ユーザーの決定。監視アプリ〈改善ループ〉の本番・本番の MCP・本番の n8n の設定スクリプトで止まったときの操作もここ。全体の順番は `setup/00-setup-overview.md`、クラウドの手順は `cloud/README.md`）。クラウドの製品（Mautic・Chatwoot・Astro。Umami は ADR-25 で廃止）と、クラウドに残す部品（`consent-api`・`admin-auth`・`faq-bot`。Cal.com は ADR-24 で SaaS〈cal.com〉に変わり、クラウドに置かない）は `cloud/` が作る。

| ディレクトリ | 内容 |
|---|---|
| `wireguard/` | オンプレと AWS の VPC をつなぐ WireGuard のオンプレ側。設定の雛形・鍵の生成・手順（[README](wireguard/README.md)） |
| `strapi/` | 本番の Strapi の compose。`backend/strapi-system` の Dockerfile でビルドし、RDS の `strapi` と S3 のメディアのバケットを使う |
| `n8n/` | 本番の n8n の compose（本体・runners・Webhook の受け口のリバースプロキシ）。RDS の `n8n` を使う |
| `systemd/` | 起動時に WireGuard のあとで Strapi・n8n を上げるユニットと、監視アプリ（`comegin-control`）を常駐させるユニットの雛形（インストールは人が行う） |

## 構成

```
                    クラウド（AWS）                                      オンプレ（このマシン）
  ┌────────────────────────────────────────┐                  ┌──────────────────────────────────────────┐
  │ Mautic・Chatwoot（ECS）                │  UDP 51820       │ wg0 = 10.99.0.2                          │
  │   │ POST http://10.99.0.2:5680/webhook/*│ ◀───────────────▶ │   │                                      │
  │   ▼                                    │  WireGuard        │   ▼                                      │
  │ WireGuard の EC2（10.99.0.1）           │  （オンプレから   │ webhook-proxy（nginx）10.99.0.2:5680     │
  │                                        │   外向きに接続）  │   │ POST /webhook/* だけ（ほかは 404）   │
  │ RDS（PostgreSQL: strapi・n8n）◀────────┼──────────────────┼─ Strapi（127.0.0.1:1338）                │
  │   ▲ 5432（EC2 で SNAT）                │                  │   │                                      │
  │   └─────────────────────────────────── ┼──────────────────┼─ n8n（127.0.0.1:5679。runners と一緒）    │
  │ S3（Strapi のメディア）◀───────────────┼── インターネット越しの API（トンネルを通さない）── Strapi       │
  │ SNS（通知）◀───────────────────────────┼── インターネット越しの API ───────────────────── n8n          │
  └────────────────────────────────────────┘                  └──────────────────────────────────────────┘
```

- **オンプレ → AWS**: Strapi・n8n が RDS（5432）に届く。**トンネルを通れるのは RDS の 5432 だけ**（EC2 の forward がそれ以外を落とす）。n8n・Strapi から Mautic・Chatwoot の API を呼ぶときは、トンネルを通らず、ALB の公開ホスト名（`mkt.`・`chat.`）を使う。使える DB は DB ユーザーの権限で `strapi` `n8n` だけ。接続は TLS で、RDS の CA を検証する（Strapi は `backend/strapi-system/Dockerfile` の `NODE_EXTRA_CA_CERTS`、n8n は `n8n/Dockerfile` の派生イメージ）。
- **AWS → オンプレ**: クラウドの Mautic・Chatwoot が、n8n の Webhook（`I-11` `I-12`）に届く。**WireGuard のアドレスには n8n 本体を開かない。** 開くのは `webhook-proxy` の 5680 だけで、エディター・API・MCP はクラウドから届かない。
- **S3・SNS**: インターネット越しの API。用途ごとに権限を絞った IAM ユーザー（`comegin-<env>-onprem-strapi-media` は Strapi のメディアのバケットだけ、`comegin-<env>-onprem-n8n-sns` は SNS の 2 トピックへの発行だけ）のアクセスキーで使う。キーは人が発行して、オンプレの秘匿ファイルにだけ置く（Claude Code の環境変数には引き継がない）。

## 起動の順番

本番の全体（AWS のデプロイから公開サイトの配信まで）の中での位置は [`setup/00-setup-overview.md`](../setup/00-setup-overview.md) の P6。

**WireGuard → Strapi → n8n** の順に上げる。下の手順は 2026-10-28 に本番で通した順番。

### 前提（AWS 側。`cloud/README.md`）

| 済ませること | 節 | 済んだかの確かめ方 |
|---|---|---|
| 本番スタックのデプロイ。RDS の CA 束のハッシュ（`RdsCaSha256`）が今の束と合っている | 4.2・4.7 | DB 作成のタスク定義の `RDS_CA_SHA256` が今の束の SHA-256（4.7 の手順 3） |
| WireGuard の接続 | 4.2.1 | `sudo wg show wg0` に `latest handshake` が出ていて、`received` が 0 B でない |
| DB とアプリ用ユーザーの作成（`db-init-postgres`） | 4.8 | `aws logs tail /comegin/prod/tasks` の最後が `db-init-postgres: done` |
| Strapi のメディア用の IAM ユーザーのキー | 4.5 | 発行して控えてある |

### 1. WireGuard

`sudo systemctl enable --now wg-quick@wg0`。手順は `cloud/README.md` の 4.2.1 と [wireguard/README.md](wireguard/README.md)。`ping -c 3 10.99.0.1` が通ってから次へ進む。

### 2. Strapi（`strapi/`）

```bash
cd onprem/strapi
./dev/init-env.sh             # .env（600）を作り、鍵類を生成する。既にある値は変えない
```

`.env` に人が入れる値（エディタで書く。画面に出さない）:

| キー | 値の出どころ |
|---|---|
| `DATABASE_HOST` | `aws rds describe-db-clusters --region ap-northeast-1 --db-cluster-identifier comegin-prod-postgres --query 'DBClusters[0].Endpoint' --output text`（IP アドレスで書かない） |
| `DATABASE_PASSWORD` | Secrets Manager の `comegin/prod/strapi/DB_PASSWORD`（`cloud/README.md` の 4.8。**DB 作成のあとに取り出す**。スタックを作り直すと値が変わる） |
| `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY` | Strapi のメディア用の IAM ユーザーのキー（4.5） |
| バケット名・PostHog のトークンなど | `.env.example` のコメント |

```bash
docker compose build          # RDS の CA 束を取得して SHA-256 を照合する（合わなければ止まる。下の「つまずいたとき」）
docker compose up -d
docker compose logs -f        # エラーが繰り返されないことを見て Ctrl+C
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1338/_health   # 204
```

### 3. n8n（`n8n/`）

```bash
cd onprem/n8n
./dev/init-env.sh             # .env（600）を作り、暗号化キーなどを生成する。N8N_ENCRYPTION_KEY は別の場所にも控える
```

`.env` に人が入れる値: `DB_POSTGRESDB_HOST`（Strapi の `DATABASE_HOST` と同じエンドポイント）と `DB_POSTGRESDB_PASSWORD`（Secrets Manager の `comegin/prod/n8n/DB_PASSWORD`。4.8）。

```bash
docker compose build
docker compose up -d
docker compose ps             # n8n・runners・webhook-proxy の 3 つが動いている（webhook-proxy は wg0 の 10.99.0.2 にバインドする）
docker compose logs -f n8n    # エラーが繰り返されないことを見て Ctrl+C
curl -s http://127.0.0.1:5679/healthz                                            # {"status":"ok"}
```

本番の n8n の Compose のプロジェクト名は `comegin-prod-n8n`、Strapi は `comegin-prod-strapi`（`compose.yml` の `name:`）。開発の `middleware/n8n`（プロジェクト名 `n8n`）とボリュームを分けるため（下の表）。

### つまずいたとき（どれも 2026-10-28 の初回で起きた）

| 症状 | 原因 | 対処 |
|---|---|---|
| `docker compose build` が `failed to solve: digest mismatch sha256:<今の束>: sha256:<固定した値>` | AWS が RDS の CA 束を更新した（意図して止めている。改ざんの検知のため） | `cloud/README.md` の 4.7 の更新の手順（中身を確かめてから、8 か所の値を更新する）→ `docker compose build --no-cache` |
| Strapi のログに `password authentication failed for user "strapi"` が繰り返される | RDS にまだ `strapi` ユーザーが無い（PostgreSQL はユーザーが無いときも同じ文言で断る）か、パスワードが Secret と違う | `cloud/README.md` の 4.8 の `db-init-postgres`（`/comegin/prod/tasks` にログが無ければ未実施）→ パスワードを取り出し直して `.env` に写す → `docker compose up -d` |
| n8n のログに `Mismatching encryption keys. The encryption key in the settings file /home/node/.n8n/config does not match the N8N_ENCRYPTION_KEY env var` | **本番の n8n が、開発の n8n のボリュームを読んだ。** プロジェクト名を書いていなかったころは、`onprem/n8n` も `middleware/n8n` もディレクトリ名から `n8n` になり、ボリューム `n8n_n8n-data`（開発の暗号化キー入り）を共有した | 今の `compose.yml` は `name:` で分けてある。古い名前で上げたコンテナが残っていれば `docker compose -p n8n down`（Strapi は `docker compose -p strapi down`）で止めてから `docker compose up -d`。**`-v` と `--remove-orphans` は付けない**（`n8n_n8n-data`・`n8n_db-data` は開発の n8n のデータ） |
| `dependency failed to start: container ... is unhealthy` | n8n 本体が起動に失敗している（runners・webhook-proxy は n8n の health を待つ） | `docker compose logs n8n` で、上の 2 行の原因を見る |
| n8n のログに `DB_POSTGRESDB_SSL_CA_FILE contained leading or trailing whitespace; the value was trimmed` | n8n は末尾が `_FILE` の環境変数をファイルの中身として読む。CA の PEM の末尾の改行を取り除いたという知らせ | 無害。対処は要らない |
| `webhook-proxy` が起動しない（`cannot assign requested address`） | wg0 が上がっておらず、`10.99.0.2` にバインドできない | 手順 1 の WireGuard を先に上げる |

### 順番の理由

- Strapi・n8n は起動時に RDS につなぐ。WireGuard が上がっていないと DB に届かず、起動に失敗する。
- **`webhook-proxy` は WireGuard のアドレス（`10.99.0.2`）にバインドする。wg0 が上がっていないと Docker がバインドできず、起動に失敗する。** `restart: unless-stopped` が再試行するが、基本は WireGuard を先に上げる。
- Strapi と n8n は互いに依存しない。順番は運用の慣習で、Strapi を先にするのは RDS の疎通を先に確かめられるため。

### 常駐させる（systemd）

`systemd/` の雛形は、`wg-quick@wg0.service` のあとに Strapi・n8n を上げる。`Requires=` なので、`wg-quick@wg0` を止める・再起動すると Strapi・n8n も止まる・再起動される（アドレスが消えるとバインドが無効になるため）。**インストールは人が行う**（`/etc` への書き込みは Claude Code では行わない）。

監視アプリ（改善ループの起動元）の雛形 `systemd/comegin-control.service` も同じ場所にある。こちらは承認済みの main のチェックアウトの `frontend/next-js` で `pnpm start` を常駐させるもので、本番の値の `.env` とビルドを済ませてから置く（`setup/00-setup-overview.md` の P14）。

```bash
# CHANGE_ME / CHANGE/ME を自分の環境に合わせて書き換えてから置く
sudo install -m 644 systemd/comegin-strapi.service systemd/comegin-n8n.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comegin-strapi.service comegin-n8n.service
```

## 監視アプリ（改善ループ）を本番で動かす

再帰的自己改善の起動元は、オンプレの監視アプリ（`frontend/next-js` ＋ `backend/control-plane`。`127.0.0.1:3200`）だけ（TA-07 の 3.5。本番の n8n はローカルのエージェントを起動できない）。監視アプリは開発と本番の区別が無い 1 つのインスタンスで、**エージェントが書き込む先が本番（`*-prod` の MCP）なので、このインスタンスを本番の値で常駐させる**。2026-11-02 の監査で、監視アプリが起動しておらず、アラーム `comegin-prod-onprem-heartbeat` が ALARM、E-15 の写しが 0 件だった。

設定スクリプトの段階 `operate` のモジュール `next-js-prod`（`frontend/next-js/setup/prod/index.mjs`）が、この節の手順を確かめ・行う。人の作業に当たると止まって案内する（下の表）。

```bash
node setup/setup.mjs --target prod --phase operate --check   # 何も変えずに、どこまで用意できているか
node setup/setup.mjs --target prod --phase operate           # 止まったら案内に従い、同じコマンドを実行し直す
```

### 守ること

- 動かすのは**承認済みの main のチェックアウト**（`CONTROL_MAIN_CHECKOUT`。空なら `SITE_BUILD_CHECKOUT`）の `frontend/next-js`。作業ツリーで `pnpm dev` したものを本番の起動元にしない（ADR-18。作業ツリーの未承認の変更が管制のコードに効いてしまう。定期実行の定義とエージェント定義をそのチェックアウトから読むのと同じ考え方）。チェックアウトの `.env` は `next-js-prod` が書き、作業ツリーの `.env`（開発のモジュールが書く）とは別のファイル
- 秘密値（AWS のキー・`GITHUB_TOKEN`・`MISWRITE_*`・`CONTROL_N8N_EXPORT_API_KEY`）は監視アプリのサーバー側だけに置き、エージェントの子プロセスには渡らない（許可リストの `env`。`backend/control-plane/README.md`）。**Claude Code に `.env` や資格情報ファイルを書かせない・読ませない**
- AWS のキーは、監視アプリ専用の資格情報ファイル（既定 `~/.config/comegin/control-plane/aws-credentials`。600）にだけ置く。`~/.aws/credentials`（管理者のキーと混ざる）や作業ツリーの中（エージェントの cwd）に置かない（`cloud/README.md` の 4.5.2）
- `ops/schedules/*.yaml` は**すべて `enabled: false`** で、`CONTROL_SCHEDULER_ENABLED=true` にしただけでは定期実行は 1 本も動かない。有効にするのは人が PR で行う（下の手順 5。`ops/README.md`）

### 止まる id と、人が行うこと

| 表示の id | いつ止まるか | すること |
|---|---|---|
| `next-js-prod:checkout` | `CONTROL_MAIN_CHECKOUT` が無い・作業ツリーと同じ・`origin/main` と違うコミット | `git -C <作業ツリー> fetch origin && git -C <チェックアウト> checkout --detach origin/main`（setup は git を書き換えない。`setup/manual-steps.md` の 6 節） |
| `next-js-prod:build` | `backend/control-plane/dist/`・`frontend/next-js/.next/` が無い、またはチェックアウトを動かす前のビルド | チェックアウトで `backend/control-plane` → `frontend/next-js` の順に `pnpm install && pnpm build`（next-js は control-plane の `dist` を読む） |
| `next-js-prod:principal` | IAM ユーザー `comegin-prod-control-plane` が無い・管理ポリシー `comegin-prod-control-plane` 以外も付いている・資格情報ファイルが無い／600 でない・そのキーの主体が違う | `cloud/README.md` の 4.5.2（ユーザーの作成・ポリシーの付与・キーの発行を人が自分の端末で）。別の場所に置いたなら `prod.conf` に `CONTROL_AWS_CREDENTIALS_FILE=` |
| `next-js-prod:prod-values` | 下の表の必須の値が `prod.conf` に無い | 表示されたキーを `prod.conf` に書く |
| `next-js-prod:systemd`・`systemd-dir` | ユニット `comegin-control` が無い・動いていない・チェックアウト以外で動いている | 下の「常駐させる（監視アプリ）」 |
| `next-js-prod:restart` | `.env` を書き換えた後に `comegin-control` を起動し直していない | `sudo systemctl restart comegin-control` |
| `next-js-prod:start` | ユニットは active だが 3200 が応答しない | `journalctl -u comegin-control -n 50` で起動の失敗を見る（control-plane の設定不正は変数名だけが出る） |

### チェックアウトの `.env` に書く値

`next-js-prod` が `prod.conf`・状態・スタックの出力から書く（`prod.conf` が正本なので、`.env` を手で直しても次の実行で戻る。`BETTER_AUTH_SECRET` は `dev/init-env.sh` が作り、触らない）。

| 変数 | 本番の値 | 出どころ |
|---|---|---|
| `BETTER_AUTH_URL`・`GOOGLE_CLIENT_*`・`CONTROL_ADMIN_EMAILS` | `prod.conf` の `CONTROL_PUBLIC_URL`・`CONTROL_GOOGLE_CLIENT_*`・`CONTROL_ADMIN_EMAILS`。無ければ、今の監視アプリ（作業ツリーの `.env`）の値を引き継ぐ（開く URL が `http://127.0.0.1:3200` 以外なら、Google のクライアントの Authorized redirect URIs に `<その URL>/api/auth/callback/google` があること） | `setup/manual-steps.md` の 7.2 |
| `CONTROL_MAIN_CHECKOUT`・`CONTROL_WORKTREE` | チェックアウト・作業ツリーの絶対パス（`CONTROL_DATA_DIR`・`CONTROL_AGENT_HOME` は `prod.conf` にあれば） | `setup/manual-steps.md` の 6 節 |
| `CONTROL_SCHEDULER_ENABLED` | `true`（`enabled: false` のジョブは登録されないので、手順 5 の PR より前に `true` でよい） | — |
| `ANTHROPIC_API_KEY` | **必須**。本番の運用に使う API キー（費用はここに付く） | `setup/manual-steps.md` の 7.3 |
| `SITE_URL` | `prod.conf` の `PUBLIC_SITE_URL`（`weekly-lighthouse` の計測対象） | — |
| `AWS_REGION`・`AWS_PROFILE`・`AWS_SHARED_CREDENTIALS_FILE`・`RUNLOG_BUCKET` | `ap-northeast-1`・`comegin-prod-control-plane`・資格情報ファイルの絶対パス・スタックの出力 `RunLogBucketName` | `cloud/README.md` の 4.5.2 |
| `MISWRITE_CHATWOOT_BASE_URL`・`..._ACCOUNT_ID`・`..._API_TOKEN`・`MISWRITE_AGENT_USER_ID` | `https://chat.comegin.com`（`CHATWOOT_BASE_URL`）・`CHATWOOT_ACCOUNT_ID`・`CHATWOOT_AGENT_TOKEN`・状態の `CHATWOOT_AGENT_USER_ID`（`chatwoot-prod` が置く）。**開発の `127.0.0.1:3100` の値にしない** | `cloud/README.md` の 7.3 |
| `GITHUB_TOKEN`・`GITHUB_REPOSITORY`・`I13_ISSUE_NUMBER`・`I13_REVIEWER` | 任意（無ければ I-13 の起票が skipped）。fine-grained PAT（このリポジトリだけ。Contents と Pull requests を Read and write）・リポジトリは空なら `origin` の URL から・起票をまとめる Issue の番号・レビュアーの GitHub のユーザー名。1 つでも書いたら 4 つとも要る | `backend/control-plane/README.md` の I-13 |
| `CONTROL_N8N_EXPORT_URL`・`CONTROL_N8N_EXPORT_API_KEY` | **判断の後で** `prod.conf` に書く。`http://127.0.0.1:5679` と本番の n8n の API キー（コミュニティ版は全権限になる） | `backend/control-plane/README.md` の n8n-export |

### 常駐させる（監視アプリ）

`systemd/comegin-control.service` の User・WorkingDirectory（チェックアウトの `frontend/next-js`）・Environment の PATH（`command -v node pnpm`）を書き換えて置く。**インストールは人が行う**。

```bash
sudo install -m 644 systemd/comegin-control.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comegin-control.service
journalctl -u comegin-control -n 50   # 「開始 scheduler=on heartbeat=on」。heartbeat=off(AWS 未設定) なら AWS の 4 変数が読めていない
```

- 作業ツリーで監視アプリを開発するときは、このユニットを止めてから `pnpm dev` する（どちらも 3200 を使う）
- ハートビートは定義の `heartbeat.yaml` に関係なく、AWS の設定があれば起動時から 5 分ごとに送られる。15 分ほどでアラーム `comegin-prod-onprem-heartbeat` が OK に戻る（`cloud/README.md` の 4.13）。**`heartbeat.yaml` は `enabled: false` のままにする**（有効にすると二重に送り、E-15 に 1 日 288 件の記録が増える。`next-js-prod` が警告する）

### 5. 定期実行を段階的に有効にする

`ops/schedules/<id>.yaml` の `enabled: true` を PR で main にマージ → チェックアウトを `checkout --detach origin/main` で合わせる（定義は 1 時間ごとに読み直される。すぐ効かせるなら `sudo systemctl restart comegin-control`）。順の目安:

1. 費用の出ない builtin: `runlog-flush`・`daily-silence-check`・`daily-miswrite-check`
2. 観測のエージェント 4 本（`daily-observe-*`）→ 数日 `success` が続いたら `daily-propose`・`daily-i13-file`（起票の PR が出始める）
3. Lighthouse・a11y（`weekly-lighthouse`・`weekly-observe-lighthouse`・`weekly-a11y`・`weekly-observe-a11y`。a11y はチェックアウトで `pnpm exec playwright install chromium` の後。DD-09 の 7 節）、`weekly-observe-serp-audit`・`published-article-check`
4. 費用が出る・本番の正本に書くもの（`weekly-keyword-research`〈OpenSEO のクレジット〉・`weekly-content-plan`・`weekly-content-draft`〈本番の Strapi に下書き〉・`monthly-analysis`）
5. `daily-n8n-export` は、本番の n8n の API キーのスコープを判断してから（`setup/00-setup-overview.md` の 6 節）

最初の定期実行の後、監視アプリの画面で `success`・`skipped` の理由を見る（`skipped` の理由は足りない変数名だけを出す）。`s3://comegin-prod-runlog-archive-<アカウント ID>/runs/` にオブジェクトが増えていること（`backend/control-plane/README.md` の「S3 への写し」）。

## 設定スクリプトが止まったときの操作（本番のオンプレ）

2026-11-02 に `setup/manual-steps.md` の 8.2・8.6・6.1 から移した（置き場所の決まりは `setup/00-setup-overview.md` の冒頭）。表示の id の早見表は `setup/manual-steps.md` の 0 節。

### 本番の MCP（`mcp-prod`）

`ops/mcp-registry.yaml` の本番の登録 6 つの env ファイル（`~/.config/comegin/mcp/<名前>` の env ファイル、600）を `prod.conf` から書く。**Chatwoot・Strapi・n8n・PostHog はエージェント専用のアカウントで発行する**（人間の管理者のトークンを使わない。ADR-17。操作の主体と権限を分けるため）。

**Mautic は例外**: Mautic の API 認証情報は、だれのものでも上流の権限は管理者になる（client_credentials は管理者が作ったときだけ付き、ロールは作った人のものが付く。2026-10-27 に上流の ApiBundle の ClientController で確認）。エージェント用（`mcp-prod`）と analytics-reporter 用（`mcp-prod-ro`）の違いは、MCP サーバの ACCESS_LEVEL（登録表）とエージェント定義の tools の許可リストだけで、Mautic 側では絞れない。認証情報を 2 つに分けるのは、片方を失効・入れ替えしても、もう片方を止めないため。

| `prod.conf` のキー | 発行するところ | 注意 |
|---|---|---|
| `CHATWOOT_AGENT_TOKEN`・`CHATWOOT_ACCOUNT_ID` | 本番の Chatwoot で、エージェント専用のユーザー（担当者の権限）を作ってログインし、プロフィール設定のアクセストークン | 担当者（agent）の権限でないと失敗にする（`chatwoot-prod` と同じ）。管理者のトークン（`CHATWOOT_ADMIN_TOKEN`）と同じ値も失敗にする |
| `MAUTIC_CLIENT_ID`・`MAUTIC_CLIENT_SECRET` | 本番の Mautic の 設定 > API 認証情報（OAuth 2。**管理者がログインして作る**。名前は `comegin-prod-mcp` など）。`setup/manual-steps.md` の 2 節と同じ手順 | 上流の権限は管理者。初期設定用（`MAUTIC_SETUP_CLIENT_*`）と同じ値は失敗にする |
| `MAUTIC_RO_CLIENT_ID`・`MAUTIC_RO_CLIENT_SECRET` | 同じ画面で、もう 1 つ作る（`mautic-prod-ro`。analytics-reporter 専用。名前は `comegin-prod-mcp-ro` など） | 上流の権限は管理者（読み取りだけに絞るのは ACCESS_LEVEL の `read_only`）。`mautic-prod` と同じ値は失敗にする |
| `STRAPI_PROD_TOKEN` | オンプレの本番の Strapi（`127.0.0.1:1338`）の管理画面で、MCP 用の Admin トークン（**下書きまで**。公開・非公開化・削除の権限を与えない） | `tools/list` に `publish_`・`unpublish_`・`delete_` が出たら失敗にする |
| `N8N_PROD_TOKEN` | オンプレの本番の n8n（`127.0.0.1:5679`）の 設定 > MCP のアクセストークン | n8n のトークンでは `publish_workflow`・`execute_workflow` を絞れない。これらを tools に含むエージェント定義は control-plane が起動しない（警告も出る） |
| `POSTHOG_PROD_API_KEY`・`POSTHOG_PROD_PROJECT_ID` | PostHog の個人 API キー（「MCP Server」のプリセットで、本番のプロジェクトの読み取りだけ）とプロジェクトの数値 ID | `phx_` で始まる個人 API キー（プロジェクトのトークン `phc_` ではない） |

確かめるのはデータの読み取りだけ（Chatwoot の `/api/v1/profile`、Mautic の client_credentials と連絡先 1 件、Strapi と n8n の MCP の `tools/list`）。`--check` でも、認証のための Mautic のトークンの発行と MCP のセッションの作成・終了は行う。env ファイルの中身が `prod.conf` と違えば `--check` が知らせる（apply で書き直す）。n8n の MCP のトークンでは公開・実行のツールを絞れないので、それらを tools に含むエージェント定義は control-plane が起動しない（`backend/control-plane/src/runner/agent.ts`）。`chatwoot-prod`・`mautic-prod*` は承認済みの main のチェックアウト（`CONTROL_MAIN_CHECKOUT`）の `dist` で動くので、そこで `pnpm install && pnpm build` が済んでいないか、chatwoot-mcp がアンダースコアのヘッダーで送る古い版（2026-10-26 より前）だと案内が出る（パッケージごとのビルドと、古い版の 3 通りの直し方は下の「MCP サーバの dist をビルドする」。修正がまだ main に入っていなければ、PR のマージが先）。

### MCP サーバの dist をビルドする（`mcp-prod:finish`）

登録表（`ops/mcp-registry.yaml`）の `chatwoot-prod`・`mautic-prod`・`mautic-prod-ro` は、このチェックアウトの `dist/index.js` を起動する。作業ツリーでビルドしても効かない。
`backend/chatwoot-mcp` と `backend/mautic-mcp` はそれぞれ自分の `pnpm-workspace.yaml`（`packages: ['.']`）を持つ別のプロジェクトなので、**片方で `pnpm install` しても、もう片方の `node_modules` はできない。パッケージごとに行う**。

```bash
git -C ~/ComeGin/systematization-of-the-business-foundation fetch origin
git -C ~/ComeGin/main-checkout checkout --detach origin/main
(cd ~/ComeGin/main-checkout/backend/chatwoot-mcp && pnpm install && pnpm build)
(cd ~/ComeGin/main-checkout/backend/mautic-mcp && pnpm install && pnpm build)
node setup/setup.mjs --target prod   # 作業ツリーで。終わった手順は飛ばす
```

PR が main にマージされてこのチェックアウトを更新したときは、**変更のあったパッケージのビルドもし直す**（`checkout` は `dist` を作り直さない）。

`mcp-prod:finish` の「アンダースコアのヘッダー（`api_access_token`）で送る古い版」は、直し方が 3 通りに分かれる。スクリプト（`ops/setup/index.mjs` の `distProblems`）がどれかを見分けて案内する。

| 案内 | 状態 | 直し方 |
|---|---|---|
| ソースは直っていて dist だけが古い | チェックアウトは新しいが、ビルドしていない | `backend/chatwoot-mcp` で `pnpm install && pnpm build` |
| チェックアウトが origin/main より古い | `origin/main` には修正があるが、チェックアウトが前のコミットを指している | 上の `checkout --detach origin/main` で合わせてからビルド |
| 修正がまだ origin/main に入っていない | 修正が作業ブランチにしか無い（**ビルドし直しても直らない**） | 修正を含むブランチを PR で main にマージしてから、上の手順でビルド |

**2026-11-02 の例**: ヘッダーの修正（ハイフンの `api-access-token`。本番の ALB の `drop_invalid_header_fields` がアンダースコアのヘッダーを捨てるため。コミット `96ea0170`）がブランチ `45-feature-dockerfile-samテンプレート` にしか無く、当時の案内（「main を最新にしてビルドし直す」）に従っても 401 のままだった。PR #48 のマージ → `checkout --detach origin/main` → `chatwoot-mcp` のビルドで解消した。続けて、`mautic-mcp` は `node_modules`・`dist` とも無く（一度も install していなかった）、同じチェックアウトで `pnpm install && pnpm build` して解消した。

### 本番の n8n（`n8n-prod`）

オンプレの本番の n8n（`http://127.0.0.1:5679`。`onprem/n8n`）に、開発の `n8n` と同じ手順でオーナー・公開 API のキー・MCP のトークンを用意し、provision（`middleware/n8n/provision`）を `--target prod` で行う（2026-10-28 から設定スクリプトに入った。以前は provision を別に実行していた）。`onprem`・`chatwoot-prod`・`mautic-prod` の後に動く。

| 表示の id | すること |
|---|---|
| `n8n-prod:mautic-api-credentials` | 本番の Mautic に管理者でログインし、設定 > API 認証情報 で OAuth 2 の認証情報を **n8n 用に別に** 作る（名前 `comegin-prod-n8n`。`setup/manual-steps.md` の 2 節と同じ手順）→ `N8N_MAUTIC_CLIENT_ID=`・`N8N_MAUTIC_CLIENT_SECRET=`。エージェント用（`MAUTIC_CLIENT_*`）・参照専用（`MAUTIC_RO_CLIENT_*`）・初期設定用（`MAUTIC_SETUP_CLIENT_*`）と同じ値は失敗にする（片方を失効しても、もう片方を止めないため。上の「本番の MCP」） |
| `n8n-prod:chatwoot-admin-token` | `CHATWOOT_ADMIN_TOKEN=`（`cloud/README.md` の 7.3 と同じ値。Webhook を作る・secret をそろえるのに要る。初期設定の後に消したなら、この実行の間だけ戻す）。週次の棚卸し用に、会話を読むだけのユーザーのトークンを `CHATWOOT_N8N_API_TOKEN=` に書くのを勧める（空なら管理者のトークンが n8n に入り、警告が出る） |
| `n8n-prod:aws-key` | IAM ユーザー `comegin-prod-onprem-n8n-sns` のアクセスキーを発行して `AWS_ACCESS_KEY_ID=`・`AWS_SECRET_ACCESS_KEY=` に書く（`cloud/README.md` の 4.5。表示されたコマンドでリポジトリの外の `~/n8n-sns.key` に直接書き、写したら `shred -u ~/n8n-sns.key`）。スクリプトは、そのキーがこのユーザーの有効なキーかを `iam list-access-keys` で確かめる（強い権限の別のキーを n8n に入れさせない） |

- オーナーは、未作成ならスクリプトが作る（メールは `ADMIN_EMAIL`、パスワードは `--target prod --show N8N_OWNER_PASSWORD`）。先に画面で作ったなら、`prod.conf` に `N8N_OWNER_PASSWORD=` を書く（`setup/manual-steps.md` の 3.5 と同じ）。
- MCP のトークンは prod の状態の `N8N_PROD_TOKEN` に入り、続く `mcp-prod` が `~/.config/comegin/mcp/n8n-prod.env` に書く。画面で作ったトークンがあるなら、その値を `prod.conf` の `N8N_PROD_TOKEN=` に書くか、`N8N_MCP_ROTATE=true`（`setup/manual-steps.md` の 4 節と同じ）。
- SNS のトピックの ARN は本番スタックの出力から読む（書かなくてよい）。Mautic・Chatwoot の Webhook の送り先は `http://10.99.0.2:5680/webhook/...`（WireGuard 越し）。
- **親（I-11・I-12）は未公開のまま**取り込む。公開は R1 の判断で、`prod.conf` に `N8N_PUBLISH_PARENTS=true` を書いて再実行する。
- **ハートビート**: アラーム `comegin-prod-onprem-n8n-schedule-heartbeat` が OK でなければ警告が出る。n8n の画面で Data Table `ops_settings` の `heartbeatEnabled` を `true` にし、「n8n スケジュール実行のハートビート」を公開する（`middleware/n8n/workflows/GUIDE.md` の 9.7・`cloud/README.md` の 4.10）。

## 開発環境との違い

開発環境（Strapi の `pnpm dev`、`middleware/n8n/compose.yml`）はそのまま動かせる。**同じマシンで本番と開発を同時に動かせるよう、ポートをずらしてある。**

| | 開発 | 本番（このモジュール） |
|---|---|---|
| Strapi | `127.0.0.1:1337`（SQLite・ローカルのアップロード） | `127.0.0.1:1338`（RDS・S3） |
| n8n（エディター・API・MCP） | `127.0.0.1:5678`（ローカルの PostgreSQL） | `127.0.0.1:5679`（RDS） |
| n8n の Webhook の受け口 | ngrok などのトンネルを手で張る | `10.99.0.2:5680`（WireGuard。`webhook-proxy`） |
| n8n のサンドボックス・SearXNG | あり | **なし**（privileged な Docker-in-Docker をオンプレの本番に置かない） |
| 環境変数ファイル | `backend/strapi-system/.env`、`middleware/n8n/.env` | `onprem/strapi/.env`、`onprem/n8n/.env`（別ファイル。値も別） |
| Compose のプロジェクト名とボリューム | `n8n`（`middleware/n8n`。ボリューム `n8n_n8n-data`・`n8n_db-data` など。開発の Strapi は Compose を使わない） | `comegin-prod-n8n`（ボリューム `comegin-prod-n8n_n8n-data`）・`comegin-prod-strapi`。`compose.yml` の `name:` で固定（2026-10-28。書かないとディレクトリ名から開発と同じ `n8n` になり、ボリュームを共有する） |
| 暗号化キー・鍵類 | 開発用 | **本番用を別に作る**。開発の値を流用しない |

MCP の登録は `ops/mcp-registry.yaml` の `strapi-prod`（`http://127.0.0.1:1338/mcp`）と `n8n-prod`（`http://127.0.0.1:5679/mcp-server/http`）。開発の `strapi-mcp`・`n8n` は 1337・5678 のまま。

## Webhook の受け口（`n8n/proxy/webhook-proxy.conf.template`）

- 通すのは **`POST /webhook/*` だけ**。`GET` など POST 以外、`/webhook-test/`・`/webhook-waiting/`、エディター・REST API・`/mcp-server/`・`/healthz`・`/` は、固定の短い本文（`not found`）の 404 を返す（nginx の既定のエラーページを出さず、そこに何があるかを教えない）。`/webhook`（末尾のスラッシュ無し）も 404。
- 本文・`Content-Type`・署名ヘッダーは書き換えずに通す。`I-11` `I-12` の署名検証は Raw Body を使うので、プロキシで本文を加工しない。署名の検証は引き続き n8n のワークフローの中で必須（この線が破られると全システムの資格情報を持つ n8n が狙われる。ADR-21 の帰結）。
- **送信元の制限: `10.99.0.1`（WireGuard の EC2）だけを受け付ける。** 許可されない送信元は、ほかと同じ 404（403 にしない。許可の有無を教えない）。EC2 が VPC からの通信を masquerade するので、本番の Webhook の送信元は**常に `10.99.0.1`**（ECS のタスクのアドレスではない）。許可する送信元は環境変数 `WEBHOOK_ALLOWED_SOURCES`（既定 `10.99.0.1`。空白区切りで複数可。IPv4 のアドレスか CIDR）で、`n8n/proxy/05-allowed-sources.sh` が起動時に nginx の `geo`（`conf.d/00-allowed-sources.conf`）へ展開する。値は形を検査し、空や不正な値なら nginx を起動せずに止める。**Docker のブリッジ（`172.16.0.0/12` など）と `127.0.0.1` は既定で許可しない**（許すと、同じマシンの別のコンテナ〈開発用のスタックを含む〉から本番の Webhook に届いてしまう。WireGuard から届く要求は、Docker が公開ポートで DNAT しても送信元の `10.99.0.1` を保って届く）。
- **流量の制限: 毎秒 20 件、バーストは 100 件、超えたら 429。** 送信元は常に `10.99.0.1` の 1 つなので、`limit_req` は送信元ごとではなく、**Mautic と Chatwoot の合計に対する全体の制限**になる。根拠: 通常のイベントは両方を合わせても毎秒 1〜2 件に届かない（Chatwoot は顧客のメッセージ 1 件ごと、Mautic はコンタクト・フォームのイベントごとに 1 件）。Mautic の一括取り込みや Chatwoot の一括処理で一時的に増えても 100 件のバーストで吸収でき、毎秒 20 件の継続は異常とみなして止める。実測した値ではなく概算なので、運用で 429 が出たら見直す。
- 本文は 1 MB まで（`client_max_body_size`）。
- ワークフローが**公開（publish）されていないと**、`/webhook/*` は n8n が 404 を返す（プロキシの 404 と見分けがつかない）。受け口の確認は、ワークフローを公開してから行う。

### 疎通の確かめ方

オンプレのマシンから、プロキシの確認をする。**既定では送信元が `10.99.0.1` 以外は 404 なので、ホスト自身からの `curl` はすべて 404 になる**（Docker のブリッジのアドレスから届くため）。確かめるときだけ、`n8n/.env` の `WEBHOOK_ALLOWED_SOURCES` にブリッジのアドレスを足し（`WEBHOOK_ALLOWED_SOURCES="10.99.0.1 172.16.0.0/12"`）、`docker compose up -d webhook-proxy` で反映する。**確かめたら、必ず `WEBHOOK_ALLOWED_SOURCES=10.99.0.1` に戻して再反映する**（ブリッジを許したままだと、同じマシンの別のコンテナから本番の Webhook に届く）。 n8n のワークフローが無くても確かめられる（未公開の `/webhook/*` への POST は n8n が 404 を返す。本文の違いで、プロキシの拒否と見分けられる）:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://10.99.0.2:5680/webhook/does-not-exist   # 404（n8n が返す。プロキシは通している）
curl -s -o /dev/null -w '%{http_code}\n' http://10.99.0.2:5680/                                  # 404（プロキシが返す）
curl -s -o /dev/null -w '%{http_code}\n' http://10.99.0.2:5680/rest/login                        # 404（プロキシが返す）
```

クラウドの側から届くことは、人が確かめる（ECS Exec で `mautic-web` のタスクに入り、`curl -X POST http://10.99.0.2:5680/webhook/does-not-exist` を送る。応答が 404 になる点はプロキシの拒否と同じなので、オンプレで `docker compose logs webhook-proxy` を見て、**送信元が `10.99.0.1` のリクエストが記録されていること**で確かめる（本文が n8n の JSON なら、プロキシを通って n8n まで届いている）。記録が無くタイムアウトなら、経路表・セキュリティグループ・EC2 内のファイアウォール・オンプレの `wg show` を順に確かめる。送信元が `10.99.0.1` 以外で記録されたら、EC2 の masquerade の設定を見直す。）

## 止まったときの影響

- **オンプレのマシン・回線・WireGuard・`webhook-proxy`・n8n のどれかが止まると、クラウドの Mautic・Chatwoot からの Webhook が届かず欠落する**（`I-11` `I-12`）。Mautic の Webhook の再送の有無は未確認（縮退運転は DD-07 で扱う）。
- 訪問者に届くサービス（Astro・Mautic・Chatwoot・`consent-api`・`admin-auth`・`faq-bot`）は止まらない（Cal.com は ADR-24 で SaaS になり、クラウドに置かないので、この一覧に入らない）。
- Strapi が止まると、記事の制作・ビルドが止まる（公開済みのページは Astro に焼き込み済みなので止まらない）。データは RDS・S3 にあるので、マシンを失っても消えない（暗号化キー・鍵類を控えてあれば復旧できる）。

## 秘匿ファイルとキー

- `strapi/.env`・`n8n/.env` は追跡しない（`.gitignore` と 600）。`.env.example` が正本で、秘密値は空欄。
- **`N8N_ENCRYPTION_KEY`（n8n）と `ENCRYPTION_KEY`（Strapi）は一度作ったら変えない。** 変えると RDS に保存済みの資格情報・暗号化した値を復号できなくなる。生成したら `.env` とは別の場所（パスワードマネージャーなど）に控える。
- RDS のパスワード・IAM ユーザーのキーは人が入れる（スクリプトは作らない）。キーは Claude Code から読めない場所にだけ置く。

### AWS 側から人が取り出すもの（`cloud/README.md` に手順がある）

| 何を | どこから | 手順 |
|---|---|---|
| RDS の DB パスワード（`strapi/.env` の `DATABASE_PASSWORD`、`n8n/.env` の `DB_POSTGRESDB_PASSWORD`） | Secrets Manager の `comegin/prod/strapi/DB_PASSWORD`・`comegin/prod/n8n/DB_PASSWORD` | `cloud/README.md` の 4.8 |
| IAM ユーザーのアクセスキー（Strapi のメディア用は `strapi/.env` の `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`、SNS 用は n8n の資格情報） | IAM ユーザー名は親スタックの出力 `OnpremStrapiMediaUserName`・`OnpremN8nSnsUserName`。キーは人が発行する | `cloud/README.md` の 4.5 |
| WireGuard の EC2 の公開鍵・Elastic IP | 出力 `WireguardServerPublicKeyParameterName`（値は SSM の `/comegin/<env>/wireguard/server-public-key`）・`WireguardPublicIp` | [wireguard/README.md](wireguard/README.md) |
| オンプレの WireGuard の公開鍵を入れる SSM パラメータ | 出力 `OnpremPublicKeyParameterName` | `cloud/README.md` の 4.2.1（`aws ssm put-parameter --overwrite`。EC2 が 2 分ごとに読み直してピアを更新する） |
