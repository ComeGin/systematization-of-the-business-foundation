#!/bin/sh
# webhook-proxy の起動時に、/webhook/ を受け付ける送信元の許可リスト（nginx の geo）を作る。
# nginx 公式イメージの entrypoint が /docker-entrypoint.d/ のスクリプトを名前順に実行する（envsubst の 20- より前）。
#
# 環境変数 WEBHOOK_ALLOWED_SOURCES: 許可する送信元。空白区切りで複数可。IPv4 のアドレスか CIDR（例 "10.99.0.1 172.16.0.0/12"）。
# 空・不正な値のときは、nginx を起動せずに終了する（許可が全開にも全閉にもならないよう、気づける形で止める）。
# 出力: /etc/nginx/conf.d/00-allowed-sources.conf（default.conf より先に読まれ、$webhook_source_ok を定義する）
set -eu

out=/etc/nginx/conf.d/00-allowed-sources.conf
sources="${WEBHOOK_ALLOWED_SOURCES:-}"

if [ -z "$(echo "$sources" | tr -d ' \t')" ]; then
    echo "05-allowed-sources: WEBHOOK_ALLOWED_SOURCES が空です（既定は 10.99.0.1）" >&2
    exit 1
fi

{
    echo "# 05-allowed-sources.sh が起動時に生成する。編集しない（WEBHOOK_ALLOWED_SOURCES で変える）"
    echo "geo \$webhook_source_ok {"
    echo "    default 0;"
    for source in $sources; do
        # 設定ファイルに埋め込む値なので、IPv4 のアドレスか CIDR の形だけを通す（; や } などを混ぜられないように）
        if ! echo "$source" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$'; then
            echo "05-allowed-sources: WEBHOOK_ALLOWED_SOURCES に不正な値があります（IPv4 のアドレスか CIDR だけ）: $source" >&2
            exit 1
        fi
        echo "    $source 1;"
    done
    echo "}"
} >"$out"

echo "05-allowed-sources: 許可する送信元: $sources"
