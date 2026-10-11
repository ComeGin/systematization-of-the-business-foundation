#!/usr/bin/env bash
# n8n の .env を用意し、パスワード・キーを生成して書き込む
#
# 使い方: dev/init-env.sh
#
# 書き換えるのは「未定義・空・.env.example の初期値のまま」の項目だけ。何度実行しても既存の値は変えない
# 値を作り直したいときは、.env の該当行を空にしてから再実行する
#   ※ POSTGRES_PASSWORD は DB ボリューム初期化時にだけ反映されるため、変えるならボリュームも作り直す
#   ※ N8N_ENCRYPTION_KEY を変えると、保存済みクレデンシャルを復号できなくなる
# 生成した値は画面に表示しない
#
# 環境変数: ENV_FILE [.env]  N8N_VERSION [下の既定値]
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
EXAMPLE_FILE=.env.example
# 更新するときは https://github.com/n8n-io/n8n/releases を確認する
N8N_VERSION="${N8N_VERSION:-2.39.5}"

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

echo "==> 既定値（未定義・空・.env.example の初期値のままの項目だけ）"
# compose.yml の ${N8N_VERSION} 展開に必要。空だと「n8nio/n8n:」という不正なイメージ名になる
# n8n 本体と runners サイドカーの両方に使うため、両者のバージョンは必ず一致する
ensure N8N_VERSION "$N8N_VERSION"
ensure GENERIC_TIMEZONE Asia/Tokyo America/New_York
ensure TZ Asia/Tokyo
ensure N8N_PORT_HOST 5678
# Code ノードのユーザーコードを別コンテナで実行する（公式は本番では external を必須としている）
ensure N8N_RUNNERS_MODE external internal
# 既定の 127.0.0.1 のままだと別コンテナの runners からブローカーに接続できない
ensure N8N_RUNNERS_BROKER_LISTEN_ADDRESS 0.0.0.0 127.0.0.1
ensure POSTGRES_USER n8n
ensure POSTGRES_DB n8n
# 5432 は Chatwoot の Postgres が使っているのでずらす
ensure POSTGRES_HOST_PORT 5433
ensure N8N_INSTANCE_AI_SEARXNG_URL http://searxng:8080

echo "==> パスワード・キーを生成（値は表示しません）"
# 保存済みクレデンシャルの暗号化キー
ensure N8N_ENCRYPTION_KEY "$(rand_alnum 48)"
# n8n（タスクブローカー）と runners コンテナの共有シークレット
ensure N8N_RUNNERS_AUTH_TOKEN "$(rand_alnum 48)"
ensure POSTGRES_PASSWORD "$(rand_alnum 32)"
postgres_password_written=$last_written
ensure SEARXNG_SECRET "$(rand_alnum 48)" change-me-searxng-secret
ensure SANDBOX_API_RUNNER_REGISTRATION_TOKEN "$(rand_alnum 48)" change-me-registration-token
ensure SANDBOX_API_RUNNER_API_KEY "$(rand_alnum 48)" change-me-runner-key

# n8n は N8N_SANDBOX_SERVICE_API_KEY で sandbox-api を呼ぶ。値が SANDBOX_API_KEYS
# （sandbox-api が受け付けるキーの一覧）に含まれていないと認証が通らないため、両者を揃えて書き込む
ensure SANDBOX_API_KEYS "$(rand_alnum 48)" change-me-api-key
if $last_written; then
    write_value N8N_SANDBOX_SERVICE_API_KEY "$(current_value SANDBOX_API_KEYS)"
    echo "  設定: N8N_SANDBOX_SERVICE_API_KEY（SANDBOX_API_KEYS と同じ値）"
elif [[ "$(current_value N8N_SANDBOX_SERVICE_API_KEY || true)" != "$(current_value SANDBOX_API_KEYS)" ]]; then
    echo
    echo "警告: N8N_SANDBOX_SERVICE_API_KEY が SANDBOX_API_KEYS と一致していません。" >&2
    echo "      このままだと n8n Assistant のサンドボックス呼び出しが認証エラーになります。" >&2
    echo "      SANDBOX_API_KEYS がカンマ区切りの複数値なら、そのいずれかと一致させてください。" >&2
fi

# 既存の DB ボリュームがあると、新しい POSTGRES_PASSWORD は反映されず接続に失敗する
if $postgres_password_written && command -v docker >/dev/null; then
    project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')}"
    if docker volume inspect "${project}_db-data" >/dev/null 2>&1; then
        echo
        echo "警告: 既存のボリューム ${project}_db-data があります。" >&2
        echo "      新しい POSTGRES_PASSWORD は反映されないため、データが不要なら次で作り直してください:" >&2
        echo "      docker compose down -v" >&2
    fi
fi

echo
echo "完了: docker compose up -d で起動し、http://localhost:$(current_value N8N_PORT_HOST || echo 5678) を開いてください"
