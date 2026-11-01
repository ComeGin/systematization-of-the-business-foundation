# onprem（オンプレの本番 Strapi・n8n と WireGuard）

ADR-21（`docs/RequirementDefinition/AA/05-application-decisions.md`）に従い、**再帰的自己改善の仕組みである Strapi と n8n の本番をオンプレで動かし、データは AWS（RDS・S3）に置く**ためのモジュール。クラウドの製品（Mautic・Chatwoot・Astro。Umami は ADR-25 で廃止）と、クラウドに残す部品（`consent-api`・`admin-auth`・`faq-bot`。Cal.com は ADR-24 で SaaS〈cal.com〉に変わり、クラウドに置かない）は `cloud/` が作る。

| ディレクトリ | 内容 |
|---|---|
| `wireguard/` | オンプレと AWS の VPC をつなぐ WireGuard のオンプレ側。設定の雛形・鍵の生成・手順（[README](wireguard/README.md)） |
| `strapi/` | 本番の Strapi の compose。`backend/strapi-system` の Dockerfile でビルドし、RDS の `strapi` と S3 のメディアのバケットを使う |
| `n8n/` | 本番の n8n の compose（本体・runners・Webhook の受け口のリバースプロキシ）。RDS の `n8n` を使う |
| `systemd/` | 起動時に WireGuard のあとで Strapi・n8n を上げるユニットの雛形（インストールは人が行う） |

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

本番の全体（AWS のデプロイから公開サイトの配信まで）の中での位置は [`docs/runbooks/00-setup-overview.md`](../docs/runbooks/00-setup-overview.md) の P6。

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

```bash
# CHANGE_ME / CHANGE/ME を自分の環境に合わせて書き換えてから置く
sudo install -m 644 systemd/comegin-strapi.service systemd/comegin-n8n.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comegin-strapi.service comegin-n8n.service
```

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
