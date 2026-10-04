# WireGuard（オンプレ側）

オンプレと AWS の VPC をつなぐ WireGuard のオンプレ側。決定は `docs/RequirementDefinition/AA/05-application-decisions.md` の ADR-21、AWS 側（小さな EC2）は `cloud/` が作る。

| 項目 | 値 |
|---|---|
| アドレス帯 | `10.99.0.0/24`（EC2 = `10.99.0.1`、オンプレ = `10.99.0.2`） |
| ポート | UDP 51820（オンプレから EC2 の Elastic IP へ外向きに接続する。オンプレの IP が変わっても使える） |
| オンプレ → AWS | RDS の 5432 だけ（EC2 で SNAT される。Mautic・Chatwoot の API はトンネルを通らず ALB の公開ホスト名を使う。使える DB は DB ユーザーの権限で `strapi` `n8n` だけに絞ってある） |
| AWS → オンプレ | `10.99.0.2:5680/tcp`（n8n の Webhook の受け口）だけ。EC2 が masquerade するので、オンプレから見た送信元は常に `10.99.0.1`。EC2 のセキュリティグループと EC2 内のファイアウォールでも絞ってある |

## ファイル

| パス | 役割 |
|---|---|
| `wg0.conf.example` | 設定の雛形。鍵は書かない。`AllowedIPs` の理由はファイル内のコメント |
| `dev/gen-keys.sh` | 鍵を作る。秘密鍵は `~/.config/comegin/wireguard/private.key`（600）、画面に出すのは公開鍵だけ。冪等 |
| `dev/render-conf.sh` | 雛形に秘密鍵・EC2 の公開鍵・Elastic IP を入れて `~/.config/comegin/wireguard/wg0.conf`（600）を作る。秘密鍵はコマンドラインにも画面にも出ない |

## 手順

前提: オンプレのマシンに `wireguard-tools`（`wg` / `wg-quick`）が入っている。

### 1. 鍵を作り、公開鍵を AWS に渡す

```bash
./dev/gen-keys.sh
```

表示された公開鍵を AWS に渡す（公開鍵は秘密ではないので CloudFormation や SSM に載せてよい）。渡し方は 2 通りあり、手順は `cloud/README.md` の 4.2.1:

- 推奨: `samconfig.toml` の `parameter_overrides` に `OnpremWireguardPublicKey=<公開鍵>` を書いて `sam deploy`（CloudFormation の値が正になる）
- すぐに反映したいとき: SSM パラメータ（名前は親スタックの出力 `OnpremPublicKeyParameterName`）に `aws ssm put-parameter --overwrite` で入れる。EC2 が 2 分ごとに読み直してピアを更新する
**秘密鍵はこのマシンの外に出さない**（Claude Code にも渡さない）。

### 2. EC2 の公開鍵と Elastic IP を取り出す

EC2 の鍵は、初回の起動時に EC2 の中で作られ、**公開鍵だけ**が SSM パラメータに出る（秘密鍵は EC2 の外に出ない）。Elastic IP は親スタックの出力にある。

EC2 の公開鍵の SSM パラメータの名前は親スタックの出力 `WireguardServerPublicKeyParameterName`（値は `/comegin/<env>/wireguard/server-public-key`）、Elastic IP は出力 `WireguardPublicIp`。取り出し方の全体は `cloud/README.md` の 4.2.1。デプロイ直後は、EC2 が起動して公開鍵を SSM に書くまで数分かかる。

```bash
# EC2 の公開鍵
aws ssm get-parameter --name /comegin/<env>/wireguard/server-public-key --query Parameter.Value --output text
# Elastic IP（親スタックの出力 WireguardPublicIp）
aws cloudformation describe-stacks --stack-name <親スタック名> --query "Stacks[0].Outputs[?OutputKey=='WireguardPublicIp'].OutputValue" --output text
```

### 3. 設定を作って置く

```bash
./dev/render-conf.sh --endpoint <Elastic IP> --server-public-key <EC2 の公開鍵>
sudo install -m 600 -o root -g root ~/.config/comegin/wireguard/wg0.conf /etc/wireguard/wg0.conf
```

`AllowedIPs` の `10.20.0.0/16` は VPC の CIDR（`cloud/template.yaml` の `VpcCidr` の既定値）。`VpcCidr` を変えた場合は `wg0.conf.example` も合わせてから作り直す（`--force`）。LAN など、オンプレ側のほかのネットワークが `10.20.0.0/16` や `10.99.0.0/24` と重なっていないことも確かめる（重なるとホストの経路が食い違う）。

### 4. 起動する

```bash
sudo wg-quick up wg0                     # 手で試すとき
sudo systemctl enable --now wg-quick@wg0 # 常駐させる（再起動後も自動で上がる）
```

`wg-quick@wg0` が Strapi・n8n より先に上がっている必要がある（`../systemd/` の雛形が `Requires=` で保証する。`../README.md` の「起動の順番」）。

### 5. 疎通を確かめる

```bash
sudo wg show wg0                         # latest handshake が 2 分以内なら鍵と経路は合っている
ping -c 3 10.99.0.1                      # EC2 まで届く
nc -vz <RDS のエンドポイント> 5432        # RDS の 5432 に届く（エンドポイントは VPC の中のアドレスに解決される）
```

- `latest handshake` が出ない: オンプレの公開鍵が親パラメータに渡っていない、`Endpoint` の Elastic IP が違う、UDP 51820 が出られない、のどれか。EC2 のセキュリティグループは UDP 51820 を受ける設定になっている。
- `ping` は通るが 5432 に届かない: RDS のセキュリティグループが WireGuard の EC2 からの 5432 を許しているか（`cloud/`）。DB ユーザーの権限は `strapi` `n8n` だけなので、別の DB 名では認証が通らない。
- 起動直後に `ping` が通らない: `PersistentKeepalive` が最初の通信を作るまで数秒かかることがある。

AWS → オンプレの向き（Webhook）は、n8n を起動してから `../README.md` の「疎通の確かめ方」で確認する。

## 注意

- **オンプレのマシンの電源・回線・`wg-quick@wg0` が止まると、クラウドの Mautic・Chatwoot からの Webhook が届かない**（`I-11` `I-12` の欠落。ADR-21 の帰結）。訪問者に届くサービスは止まらない。
- 鍵を作り直すと、EC2 側の設定（`OnpremWireguardPublicKey`）の差し替えが要る。`gen-keys.sh` は既存の鍵を作り直さない。
- 秘密鍵の置き場（`~/.config/comegin/wireguard/`）はリポジトリの外。Claude Code のエージェントが読めない場所に置き、環境変数にも載せない。
