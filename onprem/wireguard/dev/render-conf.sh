#!/usr/bin/env bash
# wg0.conf.example から、実際の WireGuard の設定（鍵入り）を作る
#
# 使い方: dev/render-conf.sh --endpoint <EC2 の Elastic IP>[:ポート] --server-public-key <EC2 の公開鍵> [--force]
#
# dev/gen-keys.sh で作った秘密鍵を読み、~/.config/comegin/wireguard/wg0.conf に 600 で書く。
# 秘密鍵はコマンドラインにも画面にも出さない（ファイルから直接読む）。
# 出力を /etc/wireguard/wg0.conf に置くのは人が行う（README.md）。
# 既にある出力は --force を付けないと上書きしない。
#
# 環境変数: COMEGIN_WG_DIR [鍵と出力の置き場。既定は ~/.config/comegin/wireguard]
set -euo pipefail

cd "$(dirname "$0")/.."

WG_DIR="${COMEGIN_WG_DIR:-$HOME/.config/comegin/wireguard}"
endpoint=""
server_key=""
force=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h | --help)
            sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        --endpoint)
            endpoint="${2:-}"
            shift 2
            ;;
        --server-public-key)
            server_key="${2:-}"
            shift 2
            ;;
        --force)
            force=true
            shift
            ;;
        *)
            echo "不明なオプション: $1（--help を参照）" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$endpoint" || -z "$server_key" ]]; then
    echo "--endpoint と --server-public-key は必須です（--help を参照）" >&2
    exit 1
fi
# ポートが無ければ既定の 51820 を付ける
if [[ "$endpoint" != *:* ]]; then
    endpoint="$endpoint:51820"
fi
# WireGuard の公開鍵は 32 バイトの base64（44 文字。末尾は =）
if [[ ! "$server_key" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
    echo "--server-public-key の形式が正しくありません（44 文字の base64）" >&2
    exit 1
fi

private_key="$WG_DIR/private.key"
if [[ ! -s "$private_key" ]]; then
    echo "秘密鍵がありません: $private_key（先に dev/gen-keys.sh を実行してください）" >&2
    exit 1
fi

output="$WG_DIR/wg0.conf"
if [[ -e "$output" && "$force" != true ]]; then
    echo "$output は既にあります。上書きするなら --force を付けてください" >&2
    exit 1
fi

umask 077
# 秘密鍵は環境変数経由で awk に渡す（コマンドラインに載せない）
ONPREM_PRIVATE_KEY="$(<"$private_key")" EC2_PUBLIC_KEY="$server_key" EC2_ENDPOINT="$endpoint" awk '
    {
        sub(/<ONPREM_PRIVATE_KEY>/, ENVIRON["ONPREM_PRIVATE_KEY"])
        sub(/<EC2_PUBLIC_KEY>/, ENVIRON["EC2_PUBLIC_KEY"])
        sub(/<EC2_ELASTIC_IP>:51820/, ENVIRON["EC2_ENDPOINT"])
        print
    }
' wg0.conf.example >"$output"
chmod 600 "$output"

echo "==> 作成: $output（秘密鍵入り。600）"
echo "    次: sudo install -m 600 -o root -g root \"$output\" /etc/wireguard/wg0.conf"
