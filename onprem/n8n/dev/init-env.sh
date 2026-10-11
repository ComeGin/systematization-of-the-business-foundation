#!/usr/bin/env bash
# 本番の n8n（オンプレ）の環境変数ファイルを用意し、暗号化キーなどを生成して書き込む
#
# 使い方: dev/init-env.sh
#
# 書き換えるのは「未定義・空・.env.example の初期値のまま」の項目だけ。何度実行しても既存の値は変えない
# 生成するのは N8N_ENCRYPTION_KEY と N8N_RUNNERS_AUTH_TOKEN だけ。RDS のエンドポイントとパスワードは人が入れる
#   ※ N8N_ENCRYPTION_KEY は一度作ったら変えない。変えると RDS に保存済みの資格情報を復号できなくなる
#      （作り直すには、環境変数ファイルの該当行を空にして再実行するが、そうしてはいけない）
# 生成した値は画面に表示しない。生成したキーは環境変数ファイルとは別の場所（パスワードマネージャーなど）に控えること
#
# 環境変数: ENV_FILE [環境変数ファイル。既定は .env]
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
EXAMPLE_FILE=.env.example

if [[ $# -gt 0 ]]; then
    case "$1" in
        -h | --help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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

# rand_alnum LENGTH: 英数字のみのランダム文字列
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
ensure GENERIC_TIMEZONE Asia/Tokyo America/New_York
ensure TZ Asia/Tokyo
ensure N8N_EDITOR_PORT_HOST 5679
ensure WG_ADDRESS 10.99.0.2
ensure WEBHOOK_ALLOWED_SOURCES 10.99.0.1
ensure DB_POSTGRESDB_PORT 5432
ensure DB_POSTGRESDB_DATABASE n8n
ensure DB_POSTGRESDB_USER n8n

echo "==> 暗号化キー・トークンを生成（値は表示しません）"
# 保存済みの資格情報の暗号化キー。一度作ったら変えない
ensure N8N_ENCRYPTION_KEY "$(rand_alnum 48)"
# n8n（タスクブローカー）と runners コンテナの共有シークレット
ensure N8N_RUNNERS_AUTH_TOKEN "$(rand_alnum 48)"

echo
echo "注意: N8N_ENCRYPTION_KEY は一度作ったら変えないこと。変えると RDS に保存済みの資格情報をすべて復号できなくなります。"
echo "      $ENV_FILE とは別の場所（パスワードマネージャーなど）に控えてください。"

# 人が入れる項目が空のままなら案内する
missing=()
for key in DB_POSTGRESDB_HOST DB_POSTGRESDB_PASSWORD; do
    if [[ -z "$(current_value "$key" || true)" ]]; then
        missing+=("$key")
    fi
done
if ((${#missing[@]} > 0)); then
    echo
    echo "次の項目は人が $ENV_FILE に入れてください（RDS のエンドポイントと n8n ユーザーのパスワード）:"
    printf '  - %s\n' "${missing[@]}"
fi

echo
echo "完了: docker compose build && docker compose up -d で起動する（WireGuard が先に上がっていること）"
