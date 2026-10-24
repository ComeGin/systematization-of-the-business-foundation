#!/usr/bin/env bash
# ローカル開発用: dev/serve.sh で起動したものを止める（PHP ビルトインサーバー・Webhook の定期実行・MySQL と MailHog のコンテナ）
#
# 使い方: dev/stop.sh [--keep-docker]
#   --keep-docker   PHP と Webhook の定期実行だけを止め、MySQL と MailHog のコンテナは動かしたままにする
#
# 環境変数: HOST [127.0.0.1], PORT [8000]（dev/serve.sh と同じ。別の値で起動したときは揃える）
# serve.sh を端末・setup（setsid nohup）・バックグラウンドのどれで起動していても止まるよう、
# serve.sh の trap に頼らず、子孫のプロセスを辿って止める。対象はこのディレクトリで動くものだけ
# コンテナは down ではなく stop で止める（コンテナと DB のボリュームは残る。MailHog の受信メールはメモリ保持のため消える）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
COMPOSE=(docker compose -f docker/compose.yaml)

keep_docker=false

for arg in "$@"; do
    case "$arg" in
        --keep-docker) keep_docker=true ;;
        -h | --help)
            sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "不明なオプション: $arg（--help を参照）" >&2
            exit 1
            ;;
    esac
done

# in_root PID: そのプロセスの作業ディレクトリがこのディレクトリか（ほかのスタックの PHP を巻き込まない）
in_root() {
    [[ "$(readlink "/proc/$1/cwd" 2>/dev/null)" == "$ROOT" ]]
}

# descendants PID: 子孫のプロセスを深さ優先で列挙する（Webhook のループの sleep・php bin/console も含む）
descendants() {
    local child
    for child in $(pgrep -P "$1" || true); do
        echo "$child"
        descendants "$child"
    done
}

# 自分とその祖先（`dev/stop.sh && dev/serve.sh` のように呼んだシェルのコマンドラインにも serve.sh が現れるため、止めない）
ancestors=" "
pid=$$
while [[ "$pid" -gt 1 ]]; do
    ancestors+="$pid "
    pid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
done

targets=()

# serve.sh 本体とその子孫（Webhook のループのサブシェルも serve.sh と同じコマンドラインで見える）
for pid in $(pgrep -f 'dev/serve\.sh' || true); do
    [[ "$ancestors" == *" $pid "* ]] && continue
    in_root "$pid" || continue
    targets+=("$pid")
    while read -r child; do
        [[ -n "$child" ]] && targets+=("$child")
    done < <(descendants "$pid")
done

# serve.sh を通さずに php -S だけを起動した場合も止める
for pid in $(pgrep -f "php -S ${HOST}:${PORT} " || true); do
    in_root "$pid" && targets+=("$pid")
done

mapfile -t targets < <(printf '%s\n' "${targets[@]}" | grep -v '^$' | sort -un)

if ((${#targets[@]} == 0)); then
    echo "PHP: 動いていません（${HOST}:${PORT}）"
else
    echo "PHP: ${#targets[@]} 個のプロセスを止めます（serve.sh・php -S ${HOST}:${PORT}・Webhook の定期実行）"
    kill -TERM "${targets[@]}" 2>/dev/null || true
    # 5 秒待っても残るものだけ強制終了する
    for _ in $(seq 1 10); do
        alive=()
        for pid in "${targets[@]}"; do
            kill -0 "$pid" 2>/dev/null && alive+=("$pid")
        done
        ((${#alive[@]} == 0)) && break
        sleep 0.5
    done
    if ((${#alive[@]} > 0)); then
        echo "PHP: ${#alive[@]} 個が SIGTERM で止まらないため強制終了します（${alive[*]}）" >&2
        kill -KILL "${alive[@]}" 2>/dev/null || true
    fi
fi

if ss -ltn "sport = :${PORT}" | grep -q "${HOST}:${PORT}\b"; then
    echo "PHP: ${HOST}:${PORT} がまだ待ち受けています（このディレクトリ以外から起動したプロセスの可能性。ss -ltnp で確認）" >&2
    exit 1
fi
((${#targets[@]} > 0)) && echo "PHP: 停止しました（${HOST}:${PORT} は空き）"

if $keep_docker; then
    echo "Docker: --keep-docker のため MySQL と MailHog は動かしたままにします"
else
    "${COMPOSE[@]}" stop
    echo "Docker: MySQL と MailHog を止めました（コンテナと DB のボリュームは残っています。再開は dev/serve.sh）"
fi
