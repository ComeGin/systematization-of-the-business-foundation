# host-relay（開発環境の中継）

開発環境で、コンテナ（n8n・Chatwoot）から、ホストの `127.0.0.1` だけで待ち受けているサービスに届くようにする中継。**開発環境だけで使う。本番には置かない**（本番の経路は ADR-21。`onprem/README.md`）。

## なぜ要るか

開発環境のサービスは、外に出さないよう `127.0.0.1` だけで待ち受けている。コンテナの中から見た `127.0.0.1` はコンテナ自身なので、別のコンテナからは届かない。

| 呼ぶ側（コンテナ） | 呼ばれる側（ホストの 127.0.0.1） | 使うところ |
|---|---|---|
| n8n | Mautic（`127.0.0.1:8000`。`backend/mautic-system/dev/serve.sh`） | `I-19` が Mautic の API でメールアドレスを検索する |
| n8n | Mautic の MailHog の SMTP（`127.0.0.1:1025`） | `I-21` が開発環境の通知を送る |
| Chatwoot（sidekiq） | n8n（`127.0.0.1:5678`） | Chatwoot の Webhook（`I-12`） |

Mautic は PHP のビルトインサーバーで 1 つのアドレスにしか待ち受けられないので、待ち受けアドレスを変えると、ブラウザと `mautic-mcp` が使っている `127.0.0.1:8000` が使えなくなる。そのため、サービス側は変えずに中継を置く。

## しくみ

socat（`alpine/socat`）を 3 つ動かす。どれも **Docker の既定のブリッジのアドレス（`docker0`。既定 `172.17.0.1`）だけ**で待ち受け、ホストの `127.0.0.1` の同じポートへ転送する。

- `docker0` のアドレスは、ホストとコンテナからしか届かない（LAN には出ない）。
- 呼ぶ側のコンテナには `extra_hosts: host.docker.internal:host-gateway` を設定してある（`middleware/n8n/compose.yml` の n8n、`backend/chatwoot-system/docker-compose.yaml` の rails と sidekiq）。`host-gateway` は `docker0` のアドレスになる。
- コンテナは読み取り専用、権限はすべて外す。

## 使い方

```bash
docker compose up -d     # 起動（再起動のたびに自動で上がる）
docker compose down      # 止める
```

`docker0` のアドレスが既定と違う場合は、`ip -4 addr show docker0` で確かめ、`RELAY_BIND=<アドレス> docker compose up -d` で起動する。

### 届くことの確かめ方

```bash
docker exec n8n-n8n-1 wget -qO- -S http://host.docker.internal:8000/ 2>&1 | head -1          # Mautic が応答する
docker exec n8n-n8n-1 sh -c 'nc -zv host.docker.internal 1025'                                # MailHog の SMTP に届く
docker exec chatwoot-system-sidekiq-1 sh -c 'wget -qO- http://host.docker.internal:5678/healthz'  # n8n が応答する
```

## 開発環境での宛先

| 設定する場所 | 値 |
|---|---|
| n8n の Data Table `ops_settings` の `mauticBaseUrl` | `http://host.docker.internal:8000` |
| n8n の資格情報 `MailHog SMTP（開発）` | Host `host.docker.internal`、Port `1025`（受信の確認は `http://127.0.0.1:8025`） |
| Chatwoot の Webhook の URL | `http://host.docker.internal:5678/webhook/chatwoot-event` |
| Mautic の Webhook の URL | `http://127.0.0.1:5678/webhook/mautic-event`（Mautic はホストで動くので中継は要らない） |

## 注意

- 中継が転送するのは上の 3 つのポートだけ。ほかのポートは足さない（足すときは README の表も更新する）。
- `docker0` で待ち受けるので、**同じホストで動くどのコンテナからも**、Mautic・MailHog・n8n に届くようになる。開発環境だけで使い、ngrok などで外に出さない。
