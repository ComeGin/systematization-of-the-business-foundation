#!/usr/bin/env bash
# オンプレ側の WireGuard の鍵を作る
#
# 使い方: dev/gen-keys.sh
#
# 秘密鍵を ~/.config/comegin/wireguard/private.key に 600 で作り、公開鍵を public.key に書く。
# 画面に出すのは公開鍵だけ（秘密鍵は表示しない）。公開鍵は SAM の親パラメータ OnpremWireguardPublicKey に渡す。
# 冪等: 秘密鍵が既にあれば作り直さず、その公開鍵を表示する。作り直すと EC2 側の設定も差し替えが要る
# （作り直したいときは、秘密鍵のファイルを自分で消してから再実行する）。
#
# 環境変数: COMEGIN_WG_DIR [鍵の置き場。既定は ~/.config/comegin/wireguard]
set -euo pipefail

WG_DIR="${COMEGIN_WG_DIR:-$HOME/.config/comegin/wireguard}"

if [[ $# -gt 0 ]]; then
    case "$1" in
        -h | --help)
            sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "不明なオプション: $1（--help を参照）" >&2
            exit 1
            ;;
    esac
fi

if ! command -v wg >/dev/null; then
    echo "wg が見つかりません。wireguard-tools（例: sudo apt install wireguard-tools）を入れてから再実行してください" >&2
    exit 1
fi

umask 077
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

private_key="$WG_DIR/private.key"
public_key="$WG_DIR/public.key"

if [[ -s "$private_key" ]]; then
    echo "==> 秘密鍵は既にあります（作り直しません）: $private_key"
else
    wg genkey >"$private_key"
    chmod 600 "$private_key"
    echo "==> 秘密鍵を作成: $private_key（画面には出しません。このマシンの外へ持ち出さない）"
fi

# 公開鍵は秘密鍵から導出する（秘密鍵は標準入力で渡し、コマンドラインに載せない）
wg pubkey <"$private_key" >"$public_key"
chmod 644 "$public_key"

echo "==> 公開鍵（SAM の親パラメータ OnpremWireguardPublicKey に渡す。秘密ではない）:"
cat "$public_key"
