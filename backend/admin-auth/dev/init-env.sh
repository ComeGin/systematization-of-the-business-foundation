#!/usr/bin/env bash
# admin-auth の環境変数ファイルを用意し、パスワード・鍵を生成して書き込む
#
# 使い方: dev/init-env.sh
#
# 書き換えるのは「未定義・空」の項目だけ。何度実行しても既存の値は変えない
# 値を作り直したいときは、環境変数ファイルの該当行を空にしてから再実行する
#   ※ DATABASE_PASSWORD は DB ボリューム初期化時にだけ反映されるため、変えるならボリュームも作り直す
#   ※ BETTER_AUTH_SECRET を変えると、既存のセッションと、暗号化して DB に置いた値（JWKS の秘密鍵など）が使えなくなる
# 生成した値は画面に表示しない。GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ADMIN_BOOTSTRAP_EMAILS は人が入れる
#
# 環境変数: ENV_FILE（書き込み先。既定は .env.example を写した、このディレクトリの環境変数ファイル）
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
EXAMPLE_FILE=.env.example

for arg in "$@"; do
    case "$arg" in
        -h | --help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "不明なオプション: $arg（--help を参照）" >&2
            exit 1
            ;;
    esac
done

if ! command -v openssl >/dev/null; then
    echo "openssl が見つかりません。インストールしてから再実行してください" >&2
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "==> $EXAMPLE_FILE から $ENV_FILE を作成"
fi
chmod 600 "$ENV_FILE"

# rand_alnum LENGTH: 英数字のみのランダム文字列（URL や sh -c に埋め込んでもエスケープ不要）
rand_alnum() {
    local s=""
    while ((${#s} < $1)); do
        s+="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')"
    done
    printf '%s' "${s:0:$1}"
}

# current_value KEY: コメントでない KEY= 行の値を出力する（複数あれば最後の行）。未定義なら終了コード 1
current_value() {
    awk -v k="$1" '
        index($0, k "=") == 1 { v = substr($0, length(k) + 2); found = 1 }
        END { if (found) print v; exit !found }
    ' "$ENV_FILE"
}

# write_value KEY VALUE: KEY= 行を置き換える。なければ「# KEY=」のコメント行を有効化し、それもなければ末尾に追記する
write_value() {
    local tmp
    tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    awk -v k="$1" -v v="$2" '
        NR == FNR {
            if (index($0, k "=") == 1) active = 1
            else if (!commented && $0 ~ ("^#[[:space:]]*" k "=")) commented = FNR
            next
        }
        (active && index($0, k "=") == 1) || (!active && FNR == commented) {
            if (!done) print k "=" v
            done = 1
            next
        }
        { print }
        END { if (!done) print k "=" v }
    ' "$ENV_FILE" "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
}

# ensure KEY VALUE [REPLACEABLE...]: 現在値が未定義・空・REPLACEABLE のいずれかなら VALUE を書き込む
ensure() {
    local key=$1 value=$2 current placeholder
    shift 2
    if current="$(current_value "$key")"; then
        for placeholder in "" "$@"; do
            if [[ "$current" == "$placeholder" ]]; then
                write_value "$key" "$value"
                echo "  設定: $key"
                return
            fi
        done
        echo "  維持: $key（設定済み）"
    else
        write_value "$key" "$value"
        echo "  設定: $key"
    fi
}

echo "==> パスワード・キーを生成（値は表示しません）"
ensure BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
ensure DATABASE_PASSWORD "$(rand_alnum 32)"
# ALB のクライアント。ID は公開しても困らない値だが、推測されにくいよう乱数を含める
ensure ALB_CLIENT_ID "alb-$(rand_alnum 16)"
ensure ALB_CLIENT_SECRET "$(rand_alnum 48)"

echo
for key in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ADMIN_BOOTSTRAP_EMAILS; do
    if [[ -z "$(current_value "$key" || true)" ]]; then
        echo "メモ: $key が空です。人が入れてください（README を参照）"
    fi
done
echo "完了: docker compose up -d --build で起動し、curl localhost:3103/.well-known/openid-configuration を確認してください"
