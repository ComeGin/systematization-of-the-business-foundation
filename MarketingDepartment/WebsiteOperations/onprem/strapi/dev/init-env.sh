#!/usr/bin/env bash
# 本番の Strapi（オンプレ）の環境変数ファイルを用意し、鍵類を生成して書き込む
#
# 使い方: dev/init-env.sh
#
# 書き換えるのは「未定義・空・.env.example の初期値のまま」の項目だけ。何度実行しても既存の値は変えない
# 生成するのは Strapi の鍵類（APP_KEYS・各 SALT・各 SECRET・ENCRYPTION_KEY）だけ。
# RDS のエンドポイントとパスワード・IAM ユーザーのキー・S3 のバケット名・PostHog のトークンは人が入れる
#   ※ ENCRYPTION_KEY を変えると、暗号化して保存済みの値（API トークンなど）を復号できなくなる
#   ※ APP_KEYS・ADMIN_JWT_SECRET・JWT_SECRET を変えると、発行済みのセッションがすべて無効になる
# 生成した値は画面に表示しない。生成した鍵は環境変数ファイルとは別の場所（パスワードマネージャーなど）に控えること
#
# 環境変数: ENV_FILE [環境変数ファイル。既定は .env]
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

# strapi_key: Strapi のひな形（create-strapi-app）と同じ形式の鍵（16 バイトの base64）
strapi_key() {
    openssl rand -base64 16
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

echo "==> 既定値（未定義・空・.env.example の初期値のままの項目だけ）"
ensure DATABASE_PORT 5432
ensure DATABASE_NAME strapi
ensure DATABASE_USERNAME strapi
ensure UPLOAD_S3_REGION ap-northeast-1
ensure POSTHOG_HOST https://us.i.posthog.com

echo "==> 鍵類を生成（値は表示しません）"
# 4 本をカンマ区切りで渡す（先頭の鍵で署名し、残りの鍵でも検証できる）
ensure APP_KEYS "$(strapi_key),$(strapi_key),$(strapi_key),$(strapi_key)"
ensure API_TOKEN_SALT "$(strapi_key)"
ensure ADMIN_JWT_SECRET "$(strapi_key)"
ensure TRANSFER_TOKEN_SALT "$(strapi_key)"
ensure JWT_SECRET "$(strapi_key)"
# 暗号化して保存する値（API トークンなど）の鍵。変えると復号できなくなる
ensure ENCRYPTION_KEY "$(strapi_key)"

echo
echo "注意: ENCRYPTION_KEY を変えると、暗号化して保存済みの値（API トークンなど）を復号できなくなります。"
echo "      $ENV_FILE とは別の場所（パスワードマネージャーなど）に控えてください。"

# 人が入れる項目が空のままなら案内する
missing=()
for key in DATABASE_HOST DATABASE_PASSWORD UPLOAD_S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY POSTHOG_PROJECT_TOKEN; do
    if [[ -z "$(current_value "$key" || true)" ]]; then
        missing+=("$key")
    fi
done
if ((${#missing[@]} > 0)); then
    echo
    echo "次の項目は人が $ENV_FILE に入れてください:"
    printf '  - %s\n' "${missing[@]}"
fi

echo
echo "完了: docker compose build && docker compose up -d で起動する（WireGuard が先に上がっていること）"
