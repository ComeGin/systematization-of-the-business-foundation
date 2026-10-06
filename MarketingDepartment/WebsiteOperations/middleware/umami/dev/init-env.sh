#!/usr/bin/env bash
# Umami（開発環境）の環境変数ファイルを用意し、パスワード・キーを生成して書き込む
#
# 使い方: dev/init-env.sh
#
# 書き換えるのは「未定義・空・ひな形の初期値のまま」の項目だけ。何度実行しても既存の値は変えない
# 値を作り直したいときは、環境変数ファイルの該当行を空にしてから再実行する
#   ※ POSTGRES_PASSWORD は DB ボリューム初期化時にだけ反映されるため、変えるならボリュームも作り直す
#   ※ APP_SECRET を変えると発行済みのログイン・トークンが無効になる
#   ※ TWO_FACTOR_ENCRYPTION_KEY を変えると、登録済みの 2 要素認証を復号できなくなる
# 生成した値は画面に表示しない
#
# 環境変数: ENV_FILE [環境変数ファイル。既定は compose.yml と同じ場所の .env]
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
EXAMPLE_FILE=.env.example

if [[ $# -gt 0 ]]; then
    case "$1" in
        -h | --help)
            sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "不明なオプション: $1（--help を参照）" >&2
            exit 1
            ;;
    esac
fi

if ! command -v openssl >/dev/null; then
    echo "openssl が見つかりません。インストールしてから再実行してください" >&2
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    echo "==> $EXAMPLE_FILE から $ENV_FILE を作成"
fi
chmod 600 "$ENV_FILE"

# rand_alnum LENGTH: 英数字のみのランダム文字列（DATABASE_URL に埋め込んでもエスケープ不要）
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
    chmod 600 "$ENV_FILE"
}

# ensure KEY VALUE [REPLACEABLE...]: 現在値が未定義・空・REPLACEABLE のいずれかなら VALUE を書き込む
# 書き込んだら last_written=true
ensure() {
    local key=$1 value=$2 current placeholder
    shift 2
    last_written=false
    if current="$(current_value "$key")"; then
        for placeholder in "" "$@"; do
            if [[ "$current" == "$placeholder" ]]; then
                write_value "$key" "$value"
                last_written=true
                echo "  設定: $key"
                return
            fi
        done
        echo "  維持: $key（設定済み）"
    else
        write_value "$key" "$value"
        last_written=true
        echo "  設定: $key"
    fi
}

echo "==> パスワード・キーを生成（値は表示しません）"
ensure APP_SECRET "$(rand_alnum 48)"
# 64 桁の hex（上流の README と同じ openssl rand -hex 32）。64 桁の hex でない値は Umami が受け付けない
ensure TWO_FACTOR_ENCRYPTION_KEY "$(openssl rand -hex 32)"
ensure POSTGRES_PASSWORD "$(rand_alnum 32)"
postgres_password_written=$last_written

# 既存の DB ボリュームがあると、新しい POSTGRES_PASSWORD は反映されず接続に失敗する
# compose.yml が name: umami を固定しているので、ボリュームは常に umami_db-data
if $postgres_password_written && command -v docker >/dev/null; then
    if docker volume inspect umami_db-data >/dev/null 2>&1; then
        echo
        echo "警告: 既存のボリューム umami_db-data があります。" >&2
        echo "      新しい POSTGRES_PASSWORD は反映されないため、データが不要なら次で作り直してください:" >&2
        echo "      docker compose down -v" >&2
    fi
fi

echo
echo "完了: docker compose up -d で起動し、http://localhost:3000 を開いてください"
