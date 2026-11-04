# onprem（オンプレの本番 Strapi・n8n・WireGuard と、改善ループの本番の設定手順）

ADR-21（`docs/RequirementDefinition/AA/05-application-decisions.md`）に従い、**再帰的自己改善の仕組みである Strapi と n8n の本番をオンプレで動かし、データは AWS（RDS・S3）に置く**ためのモジュール。**オンプレの本番の設定の手順はこの README にまとめる**（2026-11-02。ユーザーの決定。監視アプリ〈改善ループ〉の本番・本番の MCP・本番の n8n の設定スクリプトで止まったときの操作もここ。全体の順番は `setup/00-setup-overview.md`、クラウドの手順は `cloud/README.md`）。クラウドの製品（Mautic・Chatwoot・Astro。Umami は ADR-25 で廃止）と、クラウドに残す部品（`consent-api`・`admin-auth`・`faq-bot`。Cal.com は ADR-24 で SaaS〈cal.com〉に変わり、クラウドに置かない）は `cloud/` が作る。

| ディレクトリ | 内容 |
|---|---|
| `wireguard/` | オンプレと AWS の VPC をつなぐ WireGuard のオンプレ側。設定の雛形・鍵の生成・手順（[README](wireguard/README.md)） |
| `strapi/` | 本番の Strapi の compose。`backend/strapi-system` の Dockerfile でビルドし、RDS の `strapi` と S3 のメディアのバケットを使う |
| `n8n/` | 本番の n8n の compose（本体・runners・Webhook の受け口のリバースプロキシ）。RDS の `n8n` を使う |
| `systemd/` | 起動時に WireGuard のあとで Strapi・n8n を上げるユニットと、監視アプリ（`comegin-control`）・OpenSEO（`comegin-openseo`。WireGuard に依存しない）を常駐させるユニットの雛形（インストールは人が行う） |

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

監視アプリ（改善ループの起動元）の雛形 `systemd/comegin-control.service` も同じ場所にある。こちらは承認済みの main のチェックアウトの `frontend/next-js` で `pnpm start` を常駐させるもので、本番の値の `.env` とビルドを済ませてから置く（`setup/00-setup-overview.md` の P14）。OpenSEO の雛形 `systemd/comegin-openseo.service` の置き方は、下の「常駐させる（OpenSEO）」。

```bash
# CHANGE_ME / CHANGE/ME を自分の環境に合わせて書き換えてから置く
sudo install -m 644 systemd/comegin-strapi.service systemd/comegin-n8n.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comegin-strapi.service comegin-n8n.service
```

### 常駐させる（OpenSEO）

OpenSEO（`middleware/open-seo-main`。`127.0.0.1:3001`）も、オンプレで常駐させる道具（2026-11-04 に、この節を追加）。改善ループのエージェント（`seo-auditor`・`analytics-reporter`・`keyword-researcher`・`knowledge-scout`）が、夜の定期実行の中で MCP の `openseo` で Search Console・GA4・DataForSEO を読むため、止まっているとその夜の観測が欠ける。開発と本番で 1 つを共用するので、`onprem/` には置かず `middleware/` のまま動かす（TA-07 の 3.7）。設定の全体の順番は `setup/manual-steps.md` の 7.6。

**Strapi・n8n と同じく、systemd のユニット `comegin-openseo` で常駐させる**（2026-11-04 に、Docker の再起動の設定だけから改めた）。ユニットが起動のときに `docker compose up -d`、停止のときに `docker compose stop` を実行する。上流の `compose.yaml` の `restart: unless-stopped` は、動いている間に落ちたときの回復として残る。

- **Strapi・n8n との違い**: WireGuard にも RDS にも依存しない（データはこのマシンの Docker のボリューム。外へは Google と DataForSEO にインターネット越しにつなぐだけ）。そのため `Requires=` は `docker.service` だけで、`wg-quick@wg0` を止めても OpenSEO は止まらない。監視アプリのユニット（`comegin-control`）も、OpenSEO を `Wants=` に入れない（OpenSEO が止まっても、監視アプリと他の定期実行は動かし続ける）。
- **なぜユニットにしたか**: `unless-stopped` だけでは、人が `docker compose stop` したままマシンを再起動すると上がらない。ユニットなら起動のたびに `up -d` するので、止めた理由にかかわらず上がる。`systemctl status comegin-strapi comegin-n8n comegin-openseo` で、まとめて見られる。
- **`WorkingDirectory` は作業ツリーの `middleware/open-seo-main`**（設定スクリプトが環境変数ファイルを書いた場所）。監視アプリと違って main のチェックアウトにしない。環境変数ファイルはディレクトリごとにあり（`compose.yaml` の `env_file`）、別の場所に無ければ起動に失敗し、別の値で作られていれば `BETTER_AUTH_SECRET` が違うので Google の接続が切れる。

```bash
# 前提: node setup/setup.mjs --target dev --only openseo が済んでいる（環境変数ファイルの作成とイメージの取得）
# 1. 雛形の User と WorkingDirectory を自分の環境に合わせて書き換えてから置く（人が行う。/etc への書き込みは Claude Code では行わない）
sudo install -m 644 systemd/comegin-openseo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comegin-openseo.service
systemctl status comegin-openseo   # active (exited) なら正しい（Type=oneshot。コンテナは Docker が動かしている）
# 2. 確かめる（止めずに警告だけ出す。ユニット・コンテナ・本番のプロジェクトと接続を見る）
node setup/setup.mjs --target prod --phase operate --only openseo
```

既に `docker compose up -d` で動いているところにユニットを入れても、`enable --now` の `up -d` は何もせず終わる（コンテナを作り直さない）。

守ること:

- **作業で止めるときは `sudo systemctl stop comegin-openseo`、戻すときは `sudo systemctl start comegin-openseo`。** `docker compose stop` で止めると、ユニットは active のまま残り、`systemctl start` しても何もしない（`RemainAfterExit=yes`）。そのときは `sudo systemctl restart comegin-openseo` か、`middleware/open-seo-main` で `docker compose up -d` で戻す。
- 環境変数ファイルを書き換えた後の作り直し（`--force-recreate`）は、これまでどおり設定スクリプト（`--only openseo`）が行う。ユニットを通さなくてよい。
- **`docker compose down -v` をしない。** ボリューム `open-seo-main_open_seo_data` に、プロジェクトと Search Console・GA4 の OAuth のトークンが入っている。消すと、プロジェクトの作成と接続をやり直すことになる（`setup/manual-steps.md` の 7.6）。
- **環境変数ファイルの `BETTER_AUTH_SECRET` を変えない**（保存済みのトークンの暗号鍵。変えると接続が全部切れる）。
- **トンネルを張らない**（`local_noauth` で認証が無い。費用の出るツールも同じ `/mcp` にある）。別の端末から画面を開くときは `ssh -L 3001:127.0.0.1:3001` を使い、ブラウザでは `http://localhost:3001` を開く（Google の OAuth のリダイレクト URI に合わせる）。
- 夜（JST 0〜8 時）もマシンが動いていること（監視アプリと同じ。「監視アプリ（改善ループ）を本番で動かす」の 5）。

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
| `next-js-prod:status-principal` | IAM ユーザー `comegin-prod-status-reader` が無い・管理ポリシー `comegin-prod-status-reader` 以外も付いている・資格情報ファイルが無い／600 でない・そのキーの主体が違う | `cloud/README.md` の 4.5.3（下の「設定の状況を有効にする」の 1）。別の場所に置いたなら `prod.conf` に `CONTROL_STATUS_AWS_CREDENTIALS_FILE=` |
| `next-js-prod:status-github` | 参照専用の GitHub のトークンのファイルが無い／600 でない／空・`github_pat_` で始まらない（classic など）・トークンでリポジトリを読めない（401・403・404）・応答に `X-OAuth-Scopes` が付く（classic の印） | 下の「設定の状況を有効にする」の 2。別の場所に置いたなら `prod.conf` に `CONTROL_STATUS_GITHUB_TOKEN_FILE=` |
| `next-js-prod:prod-values` | 下の表の必須の値が `prod.conf` に無い | 表示されたキーを `prod.conf` に書く |
| `next-js-prod:systemd`・`systemd-dir` | ユニット `comegin-control` が無い・動いていない・チェックアウト以外で動いている | 下の「常駐させる（監視アプリ）」 |
| `next-js-prod:restart` | `.env` を書き換えた後に `comegin-control` を起動し直していない | `sudo systemctl restart comegin-control` |
| `next-js-prod:start` | ユニットは active だが 3200 が応答しない | `journalctl -u comegin-control -n 50` で起動の失敗を見る（control-plane の設定不正は変数名だけが出る） |

### チェックアウトの `.env` に書く値

`next-js-prod` が `prod.conf`・状態・スタックの出力から書く（`prod.conf` が正本なので、`.env` を手で直しても次の実行で戻る。`BETTER_AUTH_SECRET` は `dev/init-env.sh` が作り、触らない）。

| 変数 | 本番の値 | 出どころ |
|---|---|---|
| `BETTER_AUTH_URL`・`GOOGLE_CLIENT_*`・`CONTROL_ADMIN_EMAILS` | `BETTER_AUTH_URL` は `prod.conf` の `CONTROL_PUBLIC_URL`、**無ければ `http://127.0.0.1:3200`**（作業ツリーの `.env` からは引き継がない。手元以外の URL なら警告。下の「開く（監視アプリ）」）。`GOOGLE_CLIENT_*`・`CONTROL_ADMIN_EMAILS` は `prod.conf` の `CONTROL_GOOGLE_CLIENT_*`・`CONTROL_ADMIN_EMAILS`、無ければ今の監視アプリ（作業ツリーの `.env`）の値を引き継ぐ。Google のクライアントの Authorized redirect URIs に `<BETTER_AUTH_URL>/api/auth/callback/google` があること | `setup/manual-steps.md` の 7.2 |
| `CONTROL_MAIN_CHECKOUT`・`CONTROL_WORKTREE` | チェックアウト・作業ツリーの絶対パス（`CONTROL_DATA_DIR`・`CONTROL_AGENT_HOME` は `prod.conf` にあれば） | `setup/manual-steps.md` の 6 節 |
| `CONTROL_SCHEDULER_ENABLED` | `true`（`enabled: false` のジョブは登録されないので、手順 5 の PR より前に `true` でよい） | — |
| `ANTHROPIC_API_KEY` | **必須**。本番の運用に使う API キー（費用はここに付く） | `setup/manual-steps.md` の 7.3 |
| `SITE_URL` | `prod.conf` の `PUBLIC_SITE_URL`（`weekly-lighthouse` の計測対象） | — |
| `AWS_REGION`・`AWS_PROFILE`・`AWS_SHARED_CREDENTIALS_FILE`・`RUNLOG_BUCKET` | `ap-northeast-1`・`comegin-prod-control-plane`・資格情報ファイルの絶対パス・スタックの出力 `RunLogBucketName` | `cloud/README.md` の 4.5.2 |
| `CONTROL_SETUP_STATUS_ENABLED`・`CONTROL_STATUS_AWS_CREDENTIALS_FILE`・`CONTROL_STATUS_AWS_PROFILE`・`CONTROL_STATUS_GITHUB_TOKEN_FILE`・`CONTROL_STATUS_ALERT_TOPIC_ARN`・`CONTROL_STATUS_LINK_BASE` | `true`・`~/.config/comegin/status-reader/aws-credentials` の絶対パス・`default`・`~/.config/comegin/status-reader/github-token` の絶対パス・スタックの出力 `OpsAlertTopicArn`・`BETTER_AUTH_URL` と同じ値（メールのリンクの根）。ファイルの中身は書かない。画面の使い方は下の「設定の状況を有効にする」 | `cloud/README.md` の 4.5.3・`backend/control-plane/README.md` |
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

### 開く（監視アプリ）

本番の監視アプリは **`http://127.0.0.1:3200`** で開く（`127.0.0.1` にだけバインドしている）。ログインは Google（Workspace）だけで、許可リスト `CONTROL_ADMIN_EMAILS` のメールだけが通る。

- **オンプレの機械の上**: ブラウザで `http://127.0.0.1:3200` を開く。
- **別の端末から**: `ssh -L 3200:127.0.0.1:3200 <オンプレの機械>` でトンネルを張り、手元のブラウザで同じ `http://127.0.0.1:3200` を開く（ブラウザが送る `Origin` が `BETTER_AUTH_URL` と一致するので通る）。
- **本番は ngrok で外に出さない。** ADR-23 は開発の監視アプリだけを ngrok で公開するリスクを受け入れたもので、「定期実行を有効にするとき」を見直す条件にしている（2026-11-02 に有効にした）。本番の監視アプリは本番の資格情報を持ち、エージェントを起動できる。
- **auth.comegin.com（admin-auth）は使わない。** ALB の `authenticate-oidc` は ALB の後ろのターゲット（クラウドの Mautic・Chatwoot）にだけ効き、オンプレの監視アプリは ALB の後ろにいない。ALB からオンプレへ転送させると、WireGuard で `10.99.0.2:5680` だけに絞っている閉じ方が崩れる（2026-11-03 に検討して見送った）。

**ブラウザで開く URL と `BETTER_AUTH_URL` は 1 文字も違えない。** Better Auth は、Cookie を持つ要求の `Origin` が `BETTER_AUTH_URL` と違うと `403 Invalid origin` を返す（`127.0.0.1` と `localhost` は同じものとして扱う）。Google でログインした後の戻り先（リダイレクト URI）も `BETTER_AUTH_URL` から作られる。

開く URL を変えるとき（直すとき）の手順:

1. `prod.conf` の `CONTROL_PUBLIC_URL` を `http://127.0.0.1:3200` にする（空でも同じ。`next-js-prod` の既定）。`--check` は、チェックアウトの `.env` の `BETTER_AUTH_URL` がこの値と違えば ✗ を出し、手元以外の URL なら `!` で警告する。
2. Google Cloud で、監視アプリが使う OAuth クライアント（`CONTROL_GOOGLE_CLIENT_ID`）の Authorized redirect URIs に `http://127.0.0.1:3200/api/auth/callback/google` があることを確かめる（無ければ足す。`setup/manual-steps.md` の 7.2）。
3. `next-js-prod` だけを実行し直して、チェックアウトの `.env` を書き直す。**`next-js-prod` は段階 `operate` にあるので、`--phase operate` を付ける**（付けないと既定の段階 env〜apps の中だけを探し、「`--only の next-js-prod が見つからない`」で止まる）。

   ```bash
   node setup/setup.mjs --target prod --phase operate --only next-js-prod
   sudo systemctl restart comegin-control   # .env は起動したときに読まれる
   ```

4. ブラウザで `http://127.0.0.1:3200` を開き、Google でログインできることを確かめる。

| 症状 | 原因 | 直し方 |
|---|---|---|
| `Invalid origin`（403） | 開いた URL と `BETTER_AUTH_URL` が違う | 上の手順 1〜3 |
| Google が `redirect_uri_mismatch` で止める | Google のクライアントに `<BETTER_AUTH_URL>/api/auth/callback/google` が無い | 上の手順 2 |
| ngrok の URL を開くと 404 | 開発の ngrok のトンネルが張られていない（本番では使わない） | 本番は `http://127.0.0.1:3200` で開く |
| 「ログインできませんでした」で `/login` に戻る | `hd`・`email_verified`・`CONTROL_ADMIN_EMAILS` のどれかで拒否された | `journalctl -u comegin-control -n 50` の `[auth] login refused: …` で理由の種類を見る |

`BETTER_AUTH_URL` の今の値は、`.env` を開かずに確かめられる。`Origin` を付けて `sign-in/social` に投げ、返る Google の認可 URL の `redirect_uri` を見る（ログインはしない）。`Cookie` を付けないとオリジンの検査が飛ばされて 200 になるので、ダミーの `Cookie` を付ける。

```bash
curl -s -X POST http://127.0.0.1:3200/api/auth/sign-in/social \
  -H 'Origin: http://127.0.0.1:3200' -H 'Cookie: x=1' -H 'content-type: application/json' \
  -d '{"provider":"google","callbackURL":"/"}'
# 403 {"code":"INVALID_ORIGIN"} … BETTER_AUTH_URL が http://127.0.0.1:3200 ではない
# 200 {"url":"https://accounts.google.com/...&redirect_uri=http%3A%2F%2F127.0.0.1%3A3200%2Fapi%2Fauth%2Fcallback%2Fgoogle..."} … そろっている
```

**2026-11-03 の例**: `prod.conf` に `CONTROL_PUBLIC_URL` が無かった。そのため、作業ツリーの `.env` にあった開発の ngrok の URL（`https://comegin-next-js-dev.ngrok.app`）が、本番のチェックアウトの `BETTER_AUTH_URL` に引き継がれていた。`http://127.0.0.1:3200` で開くと `Invalid origin`、ngrok はトンネルが無く 404 で、どちらからも入れなかった。上の手順 1〜3 で `http://127.0.0.1:3200` にそろえ、ログインできた。同じ日に `next-js-prod` を直し、開く URL を作業ツリーから引き継がない（既定 `http://127.0.0.1:3200`）ようにして、`--check` に食い違いの検査と、手元以外の URL の警告を足した。

### 設定の状況を有効にする（/setup-status）

監視アプリの「設定の状況」画面（`/setup-status`）は、設定スクリプトの読み取り専用の確認（`node setup/setup.mjs --target prod --check`）を **1 時間ごとに子プロセスで**実行して、本番の設定の手順（`setup/00-setup-overview.md` の P1〜P15・6 節）が今どうなっているかを出す。ずれ（● 更新が必要・! 警告）が新しくなったときと、残っているあいだの 1 日 1 回のまとめを、SNS `comegin-ops-alert` のメールで知らせる。**本番の監視アプリだけで有効**（開発の `next-js` モジュールは `CONTROL_SETUP_STATUS_ENABLED=false` のまま。画面は「本番の監視アプリだけで動く」と出す）。設計は `docs/superpowers/specs/2026-11-03-setup-status-design.md`。

有効にするために、人が用意するものは 2 つ。どちらも `next-js-prod` が確かめ、無いと止まる（`next-js-prod:status-principal`・`next-js-prod:status-github`）。確かめた後、チェックアウトの `.env` に `CONTROL_SETUP_STATUS_ENABLED=true` ほか（上の表）を書く。

1. **読み取り専用の AWS の主体**（`next-js-prod:status-principal`）。IAM ユーザー `comegin-prod-status-reader` に管理ポリシー `comegin-prod-status-reader`（`cloud/stacks/iam.yaml` の `StatusReaderPolicy`）**だけ**を付け、アクセスキーを `~/.config/comegin/status-reader/aws-credentials`（600。プロファイル名 `default`）に直接書く。**監視アプリの主体（`comegin-prod-control-plane`）とは別のユーザー**にする（ハートビートと写しの送り手に、スタックや IAM の読み取りを持たせないため）。手順は `cloud/README.md` の 4.5.3（先に `sam deploy` で管理ポリシーを作る）。スクリプトは、そのキーだけで `sts get-caller-identity`（`user/comegin-prod-status-reader` で終わること）、`iam list-attached-user-policies`（`comegin-prod-status-reader` の 1 つだけ）を確かめる。
2. **参照専用の GitHub のトークン**（`next-js-prod:status-github`）。main の最新を監視アプリが自分で取るために使う（人が `git fetch` しなくても、PR のマージに気づけるようにする）。I-13 の起票用の `GITHUB_TOKEN`（Read and write）とは**別のトークン**にする。
   - GitHub の Settings → Developer settings → Fine-grained personal access tokens で作る。**Repository access は `ComeGin/systematization-of-the-business-foundation` の 1 つだけ**、**Repository permissions は Contents: Read-only と Pull requests: Read-only だけ**（Metadata は自動で Read）。有効期限を決め、切れる前に作り直す日を控える（切れると `next-js-prod:status-github` が止まり、画面が `?` になる）。
   - トークンは `~/.config/comegin/status-reader/github-token` に 1 行で、画面に出さずに直接書く（600）:

     ```bash
     ( umask 077; mkdir -p ~/.config/comegin/status-reader
       read -rs GH_STATUS_TOKEN && printf '%s\n' "$GH_STATUS_TOKEN" > ~/.config/comegin/status-reader/github-token; unset GH_STATUS_TOKEN )
     stat -c '%a %U' ~/.config/comegin/status-reader/github-token   # 600 と自分のユーザー名
     ```

   - スクリプトは、トークンが `github_pat_` で始まる（fine-grained）ことと、`GET https://api.github.com/repos/<GITHUB_REPOSITORY。無ければ ComeGin/systematization-of-the-business-foundation>` を `Authorization: Bearer` で呼んで **200** になり、応答に **`X-OAuth-Scopes` が付かない**（classic のトークンは付く）ことを確かめる。トークンの値は表示しない。classic のトークン（`ghp_` など）は止まる。
   - **Contents と Pull requests を Read-only にしたかは、スクリプトでは確かめられない。** `GET /repos` の `permissions` はトークンの範囲ではなく認証ユーザーの役割（所有者なら常に `push: true`）なので、判定に使えない。人が、作るときに両方を **Read-only** にし、ほかの権限・ほかのリポジトリを付けていないことを、トークンの設定画面で目で確かめる。

別の場所に置いたときは、`prod.conf` に `CONTROL_STATUS_AWS_CREDENTIALS_FILE=`・`CONTROL_STATUS_GITHUB_TOKEN_FILE=`（絶対パス）を書く。2 つのファイルの場所は `.env` に書くが、**中身（キー・トークン）は `.env` にも `prod.conf` にも書かない**。監視アプリの子プロセスの環境にだけ渡り、エージェントの環境には入れない（`backend/control-plane/README.md`）。

有効にした後の確かめ方:

```bash
node setup/setup.mjs --target prod --phase operate --only next-js-prod   # 2 つの id が止まらず、.env に CONTROL_SETUP_STATUS_ENABLED=true が書かれる
sudo systemctl restart comegin-control                                  # .env は起動したときに読まれる
journalctl -u comegin-control -n 50                                     # 設定の状況の確認の開始・結果の行（秘密値は出ない）
```

ブラウザで `http://127.0.0.1:3200/setup-status` を開き、「有効」の表示と、項目の状態（✓・●・!・?・◇）が出ることを確かめる。`?`（確かめられなかった）が続くときは、まず主体のキーが生きているか（`cloud/README.md` の 4.5.3 の確かめ方）と、トークンの期限を見る。

**AWS に届かないとき（キーの失効・権限・AWS の障害）は、AWS を読む項目がまとめて `?` になる**（P1・P2〜P4・P7〜P9 など。2026-11-04 から。以前は P1・P7・P8・P9 が ● になり、「更新が必要」のメールが誤って出た）。`?` は ● と違ってすぐにはメールにならず、1 時間以上続いたときに「確かめられない状態が続いている」が 1 通だけ出る。項目の根拠は「確かめられなかった: …。AWS 以外の確認は通っている」。AWS 以外に欠けがあれば、その項目は ● のままで、根拠の最後に AWS の分が付く（● の理由はほかの欠けのほう）。キーが失効したときは、`next-js-prod.status-principal`（P14）だけが ● になり、「キーで認証できない」と出る（直すのは人。`cloud/README.md` の 4.5.3 でキーを発行し直す）。

（任意）**origin の URL をリポジトリの今の名前に合わせる。** リポジトリの改名前に clone した作業ツリーは、origin が旧名（例: `https://github.com/kamegin4-aws/systematization-of-the-business-foundation.git`）のままのことがある。監視アプリは、origin の名前が設定のリポジトリ（`GITHUB_REPOSITORY`。無ければ `ComeGin/systematization-of-the-business-foundation`）と違うと、GitHub の API でその名前の転送先（`full_name`）を確かめ、同じリポジトリのときだけ `git fetch` する（プロセスの中で覚え、起動のたびに 1 回だけ API を呼ぶ）。動きはするが、`next-js-prod` の確認は `next-js-prod.status-github` を `!` 警告にし、直し方を出す（止めない）。人が自分の端末で直す（チェックアウトは作業ツリーと `.git` を共有しているので、作業ツリーで 1 回直せば両方に効く）:

```bash
git -C <作業ツリー> remote get-url origin                                                     # 今の URL
git -C <作業ツリー> remote set-url origin https://github.com/ComeGin/systematization-of-the-business-foundation.git
git -C <作業ツリー> remote get-url origin                                                     # 直った URL
```

### 5. 定期実行を段階的に有効にする

`ops/schedules/<id>.yaml` の `enabled: true` を PR で main にマージ → チェックアウトを `checkout --detach origin/main` で合わせる（定義は 1 時間ごとに読み直される。すぐ効かせるなら `sudo systemctl restart comegin-control`）。順の目安:

1. 費用の出ない builtin: `runlog-flush`・`daily-silence-check`・`daily-miswrite-check`
2. 観測のエージェント 4 本（`daily-observe-*`）→ 数日 `success` が続いたら `daily-propose`・`daily-i13-file`（起票の PR が出始める）
3. Lighthouse・a11y（`weekly-lighthouse`・`weekly-observe-lighthouse`・`weekly-a11y`・`weekly-observe-a11y`。a11y はチェックアウトで `pnpm exec playwright install chromium` の後。DD-09 の 7 節）、`weekly-observe-serp-audit`・`published-article-check`
4. 費用が出る・本番の正本に書くもの（`weekly-keyword-research`〈OpenSEO のクレジット〉・`weekly-content-plan`・`weekly-content-draft`〈本番の Strapi に下書き〉・`monthly-analysis`）
5. `daily-n8n-export` は、本番の n8n の API キーのスコープを判断してから（`setup/00-setup-overview.md` の 6 節）

- **チェックアウトを動かしたら、アプリのコードが変わっていなくても `backend/control-plane` → `frontend/next-js` の順にビルドし直し、`sudo systemctl restart comegin-control` する。** `next-js-prod:build` は、ビルドとチェックアウトの移動を日時で比べる。定義（yaml）だけの PR でも、ビルドし直すまで「まだ」と出る。
- **`heartbeat.yaml` は有効にしない**（上の「常駐させる」）。一度にまとめて有効にするときも外す。

**2026-11-02 の例**: PR #56 で 21 本を一度に `enabled: true` にした。その中に `heartbeat.yaml` も入っていて、`next-js-prod` が二重送信を警告した。PR #58 で `heartbeat.yaml` だけを `false` に戻し、チェックアウトを合わせてビルドし直し、restart した。これで段階 `operate` はすべて ✓ になった。残りの 20 本は有効のままなので、最初の実行は時刻ごとに分けて見る。

**2026-11-03 に、定期実行をすべて 0〜8 時（JST）に移した**（ユーザーの指示。時刻の決め方と終わりの上限は `ops/README.md` の「時刻の決め方」）。**PR が main に入ったら、上と同じくチェックアウトを合わせ、ビルドし直して restart する**（スケジューラは定義を読み直すが、`next-js-prod:build` の日時の比べで「まだ」と出るため）。

| 実行（JST） | 動くもの | 見ること |
|---|---|---|
| 毎日 00:00 | `published-article-check` | 最初の builtin。`success` か（未実装の間は `skipped`） |
| 月曜 00:30〜02:15 | Lighthouse → a11y → 観測 3 本（lighthouse・a11y・SERP 監査） | Lighthouse と a11y は時刻で重ねない。観測は `after` で計測の成功を待つ |
| 月曜 02:30 | `weekly-keyword-research` | **OpenSEO の費用が出る**（1 回の見積もりの上限は 2,000 クレジット） |
| 火曜 02:30 | `weekly-content-draft` | **本番の Strapi に下書きを書く**。承認済みの企画（E-03）が無ければ `skipped` |
| 水曜 02:30 | `weekly-content-plan` | 採用済みの E-01 が無ければ `skipped` |
| 毎日 04:00 | 観測のエージェント 4 本（`daily-observe-*`） | E-12 が `docs/audits/` に出るか。`success` か `skipped` か |
| 毎日 04:30 | `daily-propose` | 起票前チェックを通った E-13 が draft で出るか（根拠が少なければ出なくて正常） |
| 毎月 1 日 05:00 | `monthly-analysis` | — |
| 毎日 05:30〜06:15 | `daily-i13-file`・`daily-miswrite-check`・`daily-silence-check`・`daily-n8n-export` | builtin。i13 と n8n-export は GitHub に PR を作ることがある |

**オンプレのマシンは夜（0〜8 時）も動かしておく。** スケジューラは監視アプリのプロセスの中にあり（cron 式は Asia/Tokyo）、マシンが止まっていた時刻の実行は、起動した後に取り戻さない。2026-11-03 は、マシン（VirtualBox の VM）が 11:28 に起動したため、最初の夜の実行（00:00〜06:15）は 1 本も動かなかった。VM の中のアイドル時の休止は無効（`gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout` が `0`）でも、ホストの電源・休止と VM の自動起動はホスト側で設定する（VM の中からは確かめられない）。翌朝に `journalctl -u comegin-control --since "<その日> 00:00" | grep -a 'engine 起動'` で、0〜6 時の実行が出ていることを確かめる。

改善ループの本体はすべて 06:25 までに終わる（`timeout_sec` で打ち切られた場合も）。`runlog-flush`（写しの送り直し）も 0〜8 時の 15 分ごとで、07:50 までに終わる。昼に動くのは、監視アプリのハートビート（5 分ごと）と写しの再送だけ（どちらも改善の処理ではない）。朝 8 時以降に監視アプリの画面か `journalctl -u comegin-control --since today` で、その夜の結果をまとめて見る。

**本番の n8n の 2 本（`weekly-inquiry-inventory` を月曜 09:00 → 07:00、開発だけの `ops-monitor` の証明書の確認を 09:10 → 07:10）は、リポジトリの JSON を直しただけでは本番に入らない。** main に入った後、`node setup/setup.mjs --target prod --only n8n-prod`（provision が同名のワークフローを更新する）を実行する。provision は棚卸しを公開しない（`publish: never`）ので、**本番で公開済みなら n8n の画面で開き直して公開し直す**（公開中の版は、公開し直すまで古い時刻のまま動く）。反映しないと、`daily-n8n-export` が本番の 09:00 の版との差分を PR にして、リポジトリを古い時刻へ戻そうとする。

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
- **ハートビート**: アラーム `comegin-prod-onprem-n8n-schedule-heartbeat` が OK でなければ警告が出る。n8n の画面で Data Table `ops_settings` の `heartbeatEnabled` を `true` にし、「n8n スケジュール実行のハートビート」を公開する（`middleware/n8n/workflows/GUIDE.md` の 9.7・`cloud/README.md` の 4.10）。値は小文字の `true` だけにし、公開の前に Execute workflow で 1 回試す。画面での操作と、つまずいたときの見分け方は `cloud/README.md` の 4.10「③ と ④ の画面での操作」（2026-11-02 に有効にした）。
- **キーの入れ替え**: 新しいキーを `prod.conf` に書いて `n8n-prod` を再実行した後、古いキーを止めて消す（`cloud/README.md` の 4.5「古いキーを止めて消す」）。`n8n-prod` は「`prod.conf` のキーがこのユーザーの有効なキーか」しか見ないので、古いキーが有効なまま残っていても通ってしまう。有効なキーが 2 つあるという警告は、段階 `operate` の `cloud` が出す。

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

### 本番の Webhook の試し送信（I-11・I-12）

`setup/00-setup-overview.md` の P9 の〔未検査〕。本物のイベントを 1 つずつ起こし、Mautic・Chatwoot から WireGuard を通って n8n に届き、署名が合うことを確かめる。**本番の n8n は成功した実行を Executions に残さない**ので、届いたかは **`webhook-proxy` のアクセスログ**と **SNS `comegin-lead-alert` の通知メール**で見る（I-11・I-12 は、顧客からの要求〈フォームの送信・会話の開始〉で I-21 を呼び、`comegin-lead-alert` に送る）。前提: I-11・I-12 が公開済み（P9 の判断）・`comegin-lead-alert` を購読済み（`cloud/README.md` の 4.4）。

ログはオンプレの端末で、**末尾から**読む（`-f` で開いたまま送ってもよい）:

```bash
cd ~/ComeGin/systematization-of-the-business-foundation/onprem/n8n
docker compose logs --tail 3000 --no-log-prefix webhook-proxy | grep -a -v _proxy_health | grep -a 'POST /webhook'
```

- **`--tail` を付けずに頭から読まない。** マシンを電源断などで止めると、Docker のログのファイルに壊れた区間が残り、頭から読むとそこで黙って終わる（エラーも出ない）。2026-11-03 に、頭から読んだ出力が 11-01 14:42 で終わり、届いていた Webhook を「0 件」と読み違えた。`--tail` は末尾から読むので、壊れた区間より後ろなら読める（ヘルスチェックが 10 秒ごとに 1 行なので、3000 行でおよそ 8 時間分）。
- `grep -a` は、壊れた区間の NUL を含んでいても行を出させるため。

1. **Mautic → n8n（I-11）**: `https://comegin.com` のご相談フォームから、`@comegin.com` のテスト用アドレスで送る。Mautic はキューモードなので、`mautic-cron` の毎分の処理で 1〜2 分後に送られる。
   - ログに `10.99.0.1 … "POST /webhook/mautic-event HTTP/1.1" 200`
   - `comegin-lead-alert` の通知メールと、フォームの自動返信メールが届く
   - Mautic の歯車 → Webhooks → `n8n I-11` のログで、状態が `200`
2. **Chatwoot → n8n（I-12）**: `https://comegin.com` のチャットで、**FAQ に無い質問**（例「テストです。担当者につないでください」）を送る。Chatwoot はすぐ送る（1 つの会話で数件届く）。P12 の FAQ ボットの引き継ぎの確認を兼ねる。
   - ログに `10.99.0.1 … "POST /webhook/chatwoot-event HTTP/1.1" 200`
   - 会話の開始の通知メール（`comegin-lead-alert`）が届く
   - 会話にラベル `faq-unmatched` が付き、管理者に引き継ぎのメールが届く
3. 後片付け: Mautic のテストのコンタクトを消し、Chatwoot のテストの会話を解決にする。n8n の重複排除の表（`dedup_*`）は 7 日で消えるので触らない。

| ログの状態 | 意味 | 見直すところ |
|---|---|---|
| `200` | 届いて、署名も合った | — |
| `401` | 届いたが、署名が合わない | Mautic・Chatwoot の Webhook の secret と、n8n の Crypto 資格情報（`n8n-prod` の provision で作り直せる） |
| `404`（n8n が返す） | 届いたが、ワークフローが公開されていない | n8n で I-11・I-12 を公開する（P9 の判断） |
| `502` | プロキシまでは届いたが、n8n が起動していない | `docker compose ps`・`systemctl status comegin-n8n` |
| 行が出ない | 送る側で止まっている | Mautic の Webhook のログの `Access to private addresses is not allowed`（私設アドレスの許可は `10.99.0.2`）と、失敗続きでの自動停止。Chatwoot は CloudWatch の Sidekiq のログの `has no public ip addresses`。経路は上の ECS Exec の確認 |

**2026-11-03 の結果**: 18:23 に `mautic-event` が `200`、18:24 に `chatwoot-event` が `200`（4 件）。`comegin-lead-alert` の送信も CloudWatch の `NumberOfMessagesPublished` で確かめた。同じ日の昼には、マシンの起動の直後に Mautic のキューの送信が `502`（n8n がまだ起動していない。11:29）、親が未公開のあいだに Chatwoot が `404`（11:38）・Mautic が `404`（12:30）になっていた（下の「止まったときの影響」）。

## 止まったときの影響

- **オンプレのマシン・回線・WireGuard・`webhook-proxy`・n8n のどれかが止まると、クラウドの Mautic・Chatwoot からの Webhook が届かず欠落する**（`I-11` `I-12`）。Mautic の Webhook の再送の有無は未確認（縮退運転は DD-07 で扱う）。2026-11-03 に、マシンの起動の直後（n8n が起動する前）に Mautic のキューの送信が `502`、I-11・I-12 が未公開のあいだに Chatwoot と Mautic の送信が `404` になったのを、`webhook-proxy` のログで見た。**Chatwoot は送り直さない**ので、この間の会話の開始の通知は欠けている。マシンを起動するときは、WireGuard → Strapi → n8n が上がってから Mautic・Chatwoot のイベントが来る順になるとは限らない。
- 訪問者に届くサービス（Astro・Mautic・Chatwoot・`consent-api`・`admin-auth`・`faq-bot`）は止まらない（Cal.com は ADR-24 で SaaS になり、クラウドに置かないので、この一覧に入らない）。
- OpenSEO が止まると、SEO と GA4 の夜の観測（`daily-observe-seo`・`daily-observe-analytics`・`weekly-observe-serp-audit`）とキーワード調査が、その回の分だけ欠ける（取り戻さない）。公開サイトと訪問者には影響しない。OpenSEO の中のデータ（プロジェクト・接続）はオンプレの Docker のボリュームにだけあり、マシンを失うと作り直しになる（「常駐させる（OpenSEO）」）。
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
