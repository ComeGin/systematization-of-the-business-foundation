# host-relay（開発環境の中継）

開発環境で、コンテナ（n8n・Chatwoot）から、ホストの `127.0.0.1` だけで待ち受けているサービスに届くようにする中継。**開発環境だけで使う。本番には置かない**（本番の経路は ADR-21。`onprem/README.md`）。

## なぜ要るか

開発環境のサービスは、外に出さないよう `127.0.0.1` だけで待ち受けている。コンテナの中から見た `127.0.0.1` はコンテナ自身なので、別のコンテナからは届かない。

| 呼ぶ側（コンテナ） | 呼ばれる側（ホストの 127.0.0.1） | 使うところ |
|---|---|---|
| n8n | Mautic（`127.0.0.1:8000`。`backend/mautic-system/dev/serve.sh`） | `I-19` が Mautic の API でメールアドレスを検索する |
| n8n | Mautic の MailHog の SMTP（`127.0.0.1:1025`） | `I-21` が開発環境の通知を送る |
| Chatwoot（sidekiq） | n8n（`127.0.0.1:5678`） | Chatwoot の Webhook（`I-12`） |
| Chatwoot（sidekiq） | faq-bot（`127.0.0.1:3107`。`backend/faq-bot` の `pnpm dev`） | エージェントボット「FAQ ボット」の Webhook（`I-31`） |
| n8n | Chatwoot（`127.0.0.1:3100`） | 週次の問い合わせの棚卸し（`weekly-inquiry-inventory`）が Chatwoot の API を呼ぶ |
| n8n | OpenSEO の `GET /api/health` だけ（`127.0.0.1:3001`） | 運用監視（`ops-monitor`。TA-05 の項目 9）が OpenSEO の死活と設定を見る |

Mautic は PHP のビルトインサーバーで 1 つのアドレスにしか待ち受けられないので、待ち受けアドレスを変えると、ブラウザと `mautic-mcp` が使っている `127.0.0.1:8000` が使えなくなる。そのため、サービス側は変えずに中継を置く。

## しくみ

socat（`alpine/socat`）を 5 つ（Mautic・MailHog・n8n・Chatwoot・faq-bot）と、OpenSEO 用の nginx を 1 つ動かす。socat は **Docker の既定のブリッジのアドレス（`docker0`。既定 `172.17.0.1`）だけ**で待ち受け、ホストの `127.0.0.1` の同じポートへ転送する。

- `docker0` のアドレスは、ホストとコンテナからしか届かない（LAN には出ない）。
- 呼ぶ側のコンテナには `extra_hosts: host.docker.internal:host-gateway` を設定してある（`middleware/n8n/compose.yml` の n8n、`backend/chatwoot-system/docker-compose.yaml` の rails と sidekiq）。`host-gateway` は `docker0` のアドレスになる。
- コンテナは読み取り専用、権限はすべて外す。
- **OpenSEO（3001）だけは socat でなく nginx（`nginxinc/nginx-unprivileged`。`openseo-health.conf.template`）で `GET /api/health` だけを通し、それ以外は固定の短い本文の 404 にする。** OpenSEO は `AUTH_MODE=local_noauth`（認証なし）で、UI と `/mcp`（DataForSEO の費用が出るツールを含む）が同じポートにある。socat でポートごと中継すると、同じホストのどのコンテナからも使えてしまう。監視が要るのは `/api/health` だけなので、通す範囲をそこに絞る。上流の OpenSEO は `Host` ヘッダーが知らない名前だと 403 にするため、nginx は上流に `127.0.0.1:3001` を渡す。

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
docker exec chatwoot-system-sidekiq-1 sh -c 'wget -qO- http://host.docker.internal:3107/healthz'  # faq-bot が応答する（pnpm dev が動いているとき）
docker exec n8n-n8n-1 wget -qO- http://host.docker.internal:3100/ -S 2>&1 | head -1                  # Chatwoot が応答する
docker exec n8n-n8n-1 wget -qO- http://host.docker.internal:3001/api/health | head -c 60                 # OpenSEO の health だけ通る（/ や /mcp は 404）
```

## 開発環境での宛先

| 設定する場所 | 値 |
|---|---|
| n8n の Data Table `ops_settings` の `mauticBaseUrl` | `http://host.docker.internal:8000` |
| n8n の資格情報 `MailHog SMTP（開発）` | Host `host.docker.internal`、Port `1025`（受信の確認は `http://127.0.0.1:8025`） |
| Chatwoot の Webhook の URL | `http://host.docker.internal:5678/webhook/chatwoot-event` |
| Mautic の Webhook の URL | `http://127.0.0.1:5678/webhook/mautic-event`（Mautic はホストで動くので中継は要らない） |
| n8n の Data Table `ops_settings` の `chatwootBaseUrl` | `http://host.docker.internal:3100` |
| Chatwoot のエージェントボット「FAQ ボット」の送り先 | `http://host.docker.internal:3107/webhook`（setup の chatwoot モジュールが設定する） |
| `ops-monitor` の OpenSEO の URL | `http://host.docker.internal:3001/api/health`（ワークフローに書いてある） |

## 注意

- 中継が転送するのは上の 6 つのポート（8000・1025・5678・3100・3001〈health だけ〉・3107）だけ。ほかのポートは足さない（足すときは README の表も更新する）。
- OpenSEO を使うエージェントや人は、これまでどおり `127.0.0.1:3001` に直接つなぐ。この中継は n8n のコンテナ向けで、health 以外は通さない。
- `docker0` で待ち受けるので、**同じホストで動くどのコンテナからも**、Mautic・MailHog・n8n に届くようになる。開発環境だけで使い、ngrok などで外に出さない。
