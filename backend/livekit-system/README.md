# livekit-system（LiveKit の SFU）

音声 SEO BI エージェント（`backend/livekit-agent`）と監視アプリの `/voice` がつなぐ SFU（`livekit-server`）を動かす場所。
命名規則 `<プロダクト>-system` のとおり、ここには公式イメージを動かすための設定だけを置く（自作のコードは無い）。

- 設計: `docs/superpowers/specs/2026-11-21-voice-seo-bi-design.md`（4 節 (e)(h)・5.1・5.6）
- 計画: `docs/superpowers/plans/2026-11-21-voice-seo-bi.md`（D8・D9）
- **LiveKit Cloud は使わない**（セルフホストだけ）。

| 環境 | 置き場 | 起動 |
|---|---|---|
| 開発 | このディレクトリの `compose.yml`（`livekit-server --dev`。オンプレの開発機の `127.0.0.1`） | `docker compose up -d`（または `node setup/setup.mjs --target dev --only livekit-agent`） |
| 本番 | AWS の EC2（`cloud/stacks/livekit-sfu.yaml`。Auto Scaling グループ 0〜1 台・warm pool は Stopped）。設定の雛形は `prod/` | 人が `node cloud/livekit-sfu.mjs start`／`stop`（Claude は実行しない） |

## 開発（`compose.yml`）

```bash
cd backend/livekit-system
docker compose up -d
curl -s http://127.0.0.1:7880/      # OK が返れば動いている
docker compose logs -f livekit
docker compose down                 # 止める（データを持たないので消えるものは無い）
```

- 開発モードの API キーとシークレットは固定の `devkey`・`secret`（公開されている値。**本番では使わない**）。
  エージェントの `.env.local` には `LIVEKIT_URL=ws://127.0.0.1:7880`・`LIVEKIT_API_KEY=devkey`・`LIVEKIT_API_SECRET=secret` を入れる（setup が空のときだけ書く）。
- `network_mode: host` に `--bind 127.0.0.1` を付けて、シグナリングを `127.0.0.1` だけで受ける。
- ポート（`.claude/CLAUDE.md` のポート表）:

  | ポート | 用途 |
  |---|---|
  | 7880/tcp | API と WebSocket のシグナリング（`ws://127.0.0.1:7880`） |
  | 7881/tcp | ICE/TCP（UDP が使えないとき） |
  | 7882/udp | 開発モードの UDP の多重化（WebRTC のメディア） |

- ブラウザも開発機の上で開く（監視アプリ `http://127.0.0.1:3200/voice`）。ngrok は UDP を通せないので、
  ngrok の URL（`https://comegin-next-js-dev.ngrok.app`）から開いた画面は開発の SFU にメディアをつなげない（spec の C8）。
- 版はタグとダイジェストで固定している（`livekit/livekit-server:v1.13.11@sha256:…`）。上げるときは本番（`cloud/stacks/livekit-sfu.yaml` の `LivekitImage`）もそろえる。

## 本番（`prod/` と `cloud/stacks/livekit-sfu.yaml`）

- **`prod/livekit.yaml.template`**: livekit-server の設定。`node_ip` に Elastic IP、TURN は `external_tls: true`（TLS は Caddy が終端）。
  API キーとシークレットは SSM の SecureString（`/comegin/<env>/livekit/api-key`・`api-secret`）から起動のたびに読む。テンプレートにもリポジトリにも書かない。
- **`prod/caddy.yaml.template`**: Caddy（`livekit/caddyl4`。caddy-l4 入りの公式イメージ）が 443/tcp を受け、TLS の SNI で
  `rtc.comegin.com`（wss → `127.0.0.1:7880`）と `rtc-turn.comegin.com`（TURN/TLS → `<プライベート IP>:5349`）に振り分ける。
  証明書は Caddy が Let's Encrypt から取り、EBS（`/opt/livekit/caddy_data`）に残る。Caddyfile ではなく YAML（公式の生成器と同じ `--adapter yaml`）。
- この 2 つの雛形の正本はここで、`cloud/stacks/livekit-sfu.yaml` の UserData に同じ内容を写してある。**変えるときは両方をそろえる。**
- 起動のたびの処理は EC2 の systemd の oneshot（`comegin-livekit-boot.service`）が行う:
  IMDSv2 で自分の ID → EIP を付け直す → SSM から `livekit.yaml` を作る → `livekit-server`・`livekit-caddy` を起動 → ライフサイクルフックを CONTINUE。
  warm pool に入る起動（`Warmed:Stopped` 行き）では、設定を作らずに CONTINUE だけを返す。
- EC2 で開けるポート（SG は `cloud/stacks/network.yaml` の `LivekitSfuSecurityGroup`）: 80/tcp（証明書の取得）・443/tcp（wss と TURN/TLS）・
  7881/tcp（ICE/TCP）・3478/udp（TURN/UDP）・50000-60000/udp（メディア）。7880 と 22 は開けない（運用は SSM Session Manager）。

### EC2 の中での調べ方（SSM Session Manager で入る）

```bash
sudo journalctl -u comegin-livekit-boot -b      # 起動のたびの処理（EIP・設定・サービス・ライフサイクルフック）
sudo journalctl -u livekit-server -u livekit-caddy -f
sudo cat /var/log/livekit-setup.log              # 最初の 1 回の導入（user data）
curl -s http://127.0.0.1:7880/                   # livekit-server
```

秘密値（`/opt/livekit/livekit.yaml` の `keys`）は画面に出さない。
