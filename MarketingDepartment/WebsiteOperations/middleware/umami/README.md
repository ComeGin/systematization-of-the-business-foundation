# Umami（アクセス解析。開発環境）

公開サイト（`frontend/verdant-virgo`）のアクセスを計測する Umami を Docker Compose で動かす。
上流の取り込み（`middleware/umami-master`）の `docker-compose.yml` は「まず動かしてみる」用のサンプルなので使わず、
公式イメージを動かすための compose だけをここに自作している（`docs/RequirementDefinition/TA/04-security-and-secrets.md` の 3 節 案 C）。
本番の Umami は ECS on Fargate で動き、この compose を使わない（`cloud/images/umami`）。

## 構成

| サービス | 役割 | ホストへの公開 |
| --- | --- | --- |
| `umami` | `ghcr.io/umami-software/umami:3.4.0`（本番の `cloud/images/umami` の `UPSTREAM_TAG` と同じ版）。MCP（`/mcp`）は `MCP_ENABLED=1` で有効 | `127.0.0.1:3000` |
| `db` | PostgreSQL 15（`postgres:15-alpine`）。ボリューム `umami_db-data` | なし |

上流のサンプルとの違い（TA-04 の課題 1〜4）:

| 課題 | 上流のサンプル | この compose |
| --- | --- | --- |
| 1 全インターフェース公開 | `"3000:3000"` | `127.0.0.1:3000:3000` |
| 2 `APP_SECRET` がプレースホルダ | `replace-me-with-a-random-string` | `.env`（追跡対象外）から参照。`dev/init-env.sh` が生成 |
| 3 `TWO_FACTOR_ENCRYPTION_KEY` がプレースホルダ | `replace-me-with-a-64-character-hex-string` | 同上（64 桁の hex） |
| 4 DB が `umami` / `umami` | `POSTGRES_PASSWORD: umami` | 同上（32 文字の英数字） |

## 起動

開発環境の一式は `setup/setup.mjs` が用意する（Umami だけなら `node setup/setup.mjs --target dev --only umami`。
`dev/init-env.sh` の実行・起動・管理者のパスワードの変更・Web サイト・API キー・MCP の env まで行う）。手で動かすなら:

```bash
./dev/init-env.sh      # .env を作り、APP_SECRET・TWO_FACTOR_ENCRYPTION_KEY・POSTGRES_PASSWORD を生成する（冪等。値は表示しない）
docker compose up -d
```

`http://localhost:3000` を開く。初期の管理者は `admin` / `umami`（`setup/setup.mjs` が生成した値に変える）。

```bash
ss -ltn | grep ':3000 '                                                    # 127.0.0.1:3000 だけで待ち受けていること
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/mcp   # 401（MCP が有効。無効なら 404）
```

`.env` の秘密値は、変えると次のものが壊れる。作り直したいときは該当行を空にして `dev/init-env.sh` を再実行する。

| 変数 | 変えたときの影響 |
| --- | --- |
| `APP_SECRET` | 発行済みのログイン・トークンがすべて無効になる |
| `TWO_FACTOR_ENCRYPTION_KEY` | 登録済みの 2 要素認証を復号できなくなる |
| `POSTGRES_PASSWORD` | **DB ボリュームの初期化時にしか反映されない**。変えるなら DB 側で `ALTER USER` するか、ボリュームを作り直す |

## 旧スタック（`umami-master`）からの移行

これまで開発環境の Umami は `middleware/umami-master` の上流の compose（project 名 `umami-master`）で動かしていた。
**新しいスタックはボリュームが別（`umami_db-data`）で、旧スタックのデータは引き継がない**（開発用のデータなので作り直してよいと決めている）。

1. 旧スタックを止める。**`-v` を付けない**（付けると旧スタックのボリュームが消える）。3000 が衝突するので、起動より先に止める。

   ```bash
   docker compose -p umami-master down
   ```

2. 新しいスタックを起動する。

   ```bash
   cd middleware/umami
   ./dev/init-env.sh
   docker compose up -d
   ```

3. setup を再実行する。管理者（初期値に戻っている）のパスワードを状態の値に設定し直し、Web サイトと API キーを作り直し、`~/.config/comegin/mcp/umami-dev.env` を新しい API キーで書き換える。

   ```bash
   node setup/setup.mjs --target dev --only umami
   ```

古いボリューム（`umami-master_umami-db-data`、および過去に project 名 `umami` で作られた `umami_umami-db-data`）は**消えずに残る**。
不要と判断したら、人が `docker volume rm` で消す（setup も compose もボリュームを消さない）。

## 環境変数ファイル（`.env`）の置き場

`.env` は `compose.yml` と同じディレクトリに置く（追跡対象外。`.gitignore` で除外）。
ひな形は `.env.example`。`setup/setup.mjs` が書く値（管理者のパスワード・API キー）は `.env` ではなく
`~/.config/comegin/setup/dev.state.json` と `~/.config/comegin/mcp/umami-dev.env` に置く。
