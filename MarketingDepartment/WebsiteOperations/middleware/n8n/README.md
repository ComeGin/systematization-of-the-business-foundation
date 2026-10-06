# n8n（Web サイト運用・SEO 対策のワークフロー基盤）

SaaS システム販売事業の事業経営基盤のうち、Web サイト運用・SEO 対策の定型作業を
ワークフローとして自動化するための n8n を Docker Compose で動かす。

## 構成

| サービス | 役割 | ホストへの公開 |
| --- | --- | --- |
| `n8n` | ワークフローエディタ本体 | `127.0.0.1:5678` |
| `postgres` | n8n のデータベース（PostgreSQL 18） | `127.0.0.1:5433` |
| `runners` | Code ノードのユーザーコードを実行するサイドカー（external モード） | なし |
| `sandbox-certs` | サンドボックス間 mTLS の証明書を生成して終了する一回限りのジョブ。**公開部分（`*.crt`）だけを `/tls/public` にもコピーする**（`n8n` が期限を読むため） | なし |
| `sandbox-api` | n8n Assistant がコードを実行するときの制御プレーン | なし |
| `sandbox-runner-1` | 実際にサンドボックスを作って動かす privileged な Docker-in-Docker | なし |
| `searxng` | n8n Assistant の Web 検索バックエンド | なし |

ホスト側のポートはすべてループバックにバインドしている。外部公開が必要なときは
ngrok などのトンネルをホスト側で張り、`.env` の `N8N_WEBHOOK_URL` を払い出された URL に合わせる。

同じリポジトリの他スタックとポートが衝突しないよう、3000 は Umami、3100 は Chatwoot、
5432 は Chatwoot の PostgreSQL を避けている。

## 起動

```bash
./dev/init-env.sh      # .env を作り、パスワード・キーを生成する（既存の値は変えない）
docker compose up -d
```

`http://localhost:5678` を開く。初回はアカウント作成画面が出る。

## 動作確認

```bash
docker compose ps                                          # 全サービスの状態
curl -sf http://localhost:5678/healthz                      # n8n
docker compose exec n8n wget -qO- http://sandbox-api:8080/healthz   # n8n -> sandbox-api
docker compose logs sandbox-api | grep -i "runner registered"       # サンドボックスの登録
docker compose logs n8n | grep -i "Registered runner"               # タスクランナーの接続
```

## n8n Assistant を有効にする

サンドボックスと Web 検索は起動済みだが、モデルを与えるまで Assistant 自体は動かない。
n8n の UI（インスタンスの AI 設定）から設定するか、`.env` に次を書いて
`docker compose up -d n8n` で反映する。

```
N8N_INSTANCE_AI_MODEL_API_KEY=sk-ant-xxx
```

プロンプト・ワークフローの内容・Assistant が読む実行データは、指定したプロバイダに送られる。

## 実行履歴の保持（90 日）

DA-05 の 2 節（n8n の実行履歴は 90 日で消す）のため、`compose.yml` の n8n の `environment:` に次を書いてある（`env_file` の環境変数ファイルより優先されるので、環境変数ファイルを更新しなくても効く。変えたいときは `.env.example` の説明のとおり）。

| 変数 | 値 | 理由 |
|---|---|---|
| `EXECUTIONS_DATA_PRUNE` | `true` | 既定と同じだが明示する |
| `EXECUTIONS_DATA_MAX_AGE` | `2160`（時間 = 90 日） | DA-05 |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `50000` | n8n の既定（10,000）だと 90 日に届く前に件数で消える。DB の肥大の安全弁として上限は残す |

- 出典: https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/executions
- 5 分ごとのハートビートなどは、ワークフローの設定で**成功した実行を保存しない**（保存すると件数の上限に早く当たる）。
- 本番（`onprem/n8n/compose.yml`）にも同じ値を書いてある。**成功した実行の入出力を保存しない設定をインスタンス全体にするか**は決めていない（DA-05 の未決定事項。ワークフローごとの設定を使っている）。

## 運用監視（`ops-monitor`）が読む `sandbox-tls` の公開部分

`ops-monitor` の「`sandbox-tls` の証明書の期限」（TA-05 の項目 5）は、n8n の `Read/Write Files from Disk` で証明書を読む。n8n 2.0 以降このノードは既定で `~/.n8n-files` の下しか読めない（`N8N_RESTRICT_FILE_ACCESS_TO` の既定。https://docs.n8n.io/changelog/v20-breaking-changes）ので、`sandbox-tls` ボリュームの **`public/`（公開部分の `*.crt` だけ）を `/home/node/.n8n-files/sandbox-tls` に読み取り専用でマウント**している（Compose の long syntax の `volume.subpath`）。**秘密鍵（`*.key`・`ca.key`）は n8n に渡さない。** `public/` は `sandbox-certs` が作る（`docker compose up -d` のたびに再実行されるが、`bootstrap-mtls.sh` は証明書がそろっていれば何もしないので安全）。既存のボリュームでも、`docker compose up -d` で `public/` ができる。

## 運用上の注意

- **暗号化キー**: `N8N_ENCRYPTION_KEY` は保存済みクレデンシャルの復号に必要。`.env` ごと
  安全な場所にバックアップする。失うと登録済みの認証情報を復元できない。
- **サンドボックスの隔離**: `sandbox-runner-1` は `privileged: true` の Docker-in-Docker で、
  公式も「ホストの root 相当」と警告している。このコンテナのポートは公開しない。
  本番運用では n8n が推奨する Daytona のマネージドサンドボックスへの切り替えを検討する。
- **秘密値の分離**: `sandbox-api` と `sandbox-runner-1` には `env_file: .env` を使わず、
  必要な変数だけを `compose.yml` の `environment:` で渡している。暗号化キー・DB パスワード・
  モデル API キーが privileged コンテナに渡らないようにするため（公式のセキュリティ
  チェックリストに準拠）。
- **証明書の更新**: `sandbox-certs` が作る mTLS 証明書は自動更新されない（葉の証明書は発行から約 825 日。2026-09-16 発行のものは 2028-12-19 まで）。期限が切れたら
  `docker compose down` のあと `docker volume rm n8n_sandbox-tls` で作り直す（`public/` も作り直される）。**期限は `ops-monitor` が毎日見て、残り 30 日未満で `ops` に通知する**（`ops_settings` の `opsMonitorEnabled` が `true` のとき）。
- **バージョン更新**: `n8nio/n8n` と `n8nio/runners` のバージョンは必ず一致させる。
  `.env` の `N8N_VERSION` を変えて `docker compose up -d` する。

## 参考

- [Install using Docker Compose](https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose)
- [Set up task runners](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-task-runners)
- [Configure webhook URLs with reverse proxy](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/configure-webhook-urls-with-reverse-proxy)
