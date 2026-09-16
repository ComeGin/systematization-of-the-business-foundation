#!/usr/bin/env bash
# Chatwoot の .env を用意し、パスワード・キーを生成して書き込む
#
# 使い方: dev/init-env.sh [--no-dev-defaults]
#   --no-dev-defaults   ローカル開発用の既定値（URL・ロケール・MailHog 送信設定）を書き込まず、秘密値の生成だけ行う
#
# 書き換えるのは「未定義・空・.env.example の初期値のまま」の項目だけ。何度実行しても既存の値は変えない
# 値を作り直したいときは、.env の該当行を空にしてから再実行する
#   ※ POSTGRES_PASSWORD は DB ボリューム初期化時にだけ反映されるため、変えるならボリュームも作り直す
#   ※ ACTIVE_RECORD_ENCRYPTION_* を変えると、暗号化済みのデータ（2 要素認証の設定など）を復号できなくなる
# 生成した値は画面に表示しない
#
# 環境変数: ENV_FILE [.env]  CHATWOOT_PORT [3100]
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
EXAMPLE_FILE=.env.example
CHATWOOT_PORT="${CHATWOOT_PORT:-3100}"

dev_defaults=true

for arg in "$@"; do
    case "$arg" in
        --no-dev-defaults) dev_defaults=false ;;
        -h | --help)
            sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
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
ensure SECRET_KEY_BASE "$(openssl rand -hex 64)" replace_with_lengthy_secure_hex
ensure POSTGRES_PASSWORD "$(rand_alnum 32)"
postgres_password_written=$last_written
ensure REDIS_PASSWORD "$(rand_alnum 32)"
# rails db:encryption:init と同じ形式（英数字 32 文字）
ensure ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY "$(rand_alnum 32)"
ensure ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY "$(rand_alnum 32)"
ensure ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT "$(rand_alnum 32)"

if $dev_defaults; then
    echo "==> ローカル開発用の既定値（.env.example の初期値のままの項目だけ）"
    ensure CHATWOOT_PORT "$CHATWOOT_PORT"
    ensure FRONTEND_URL "http://localhost:$CHATWOOT_PORT" "http://0.0.0.0:3000"
    ensure DEFAULT_LOCALE ja en
    # docker-compose.yaml の POSTGRES_DB の既定値と揃える（空だと Chatwoot は chatwoot_production を使う）
    ensure POSTGRES_DATABASE chatwoot
    # 同梱の MailHog（profiles: dev）を起動し、Chatwoot のメールをそこへ送る
    ensure COMPOSE_PROFILES dev
    ensure SMTP_ADDRESS mailhog
    ensure SMTP_PORT 1025
    ensure SMTP_ENABLE_STARTTLS_AUTO false true
    ensure SMTP_OPENSSL_VERIFY_MODE none peer
fi

# 既存の DB ボリュームがあると、新しい POSTGRES_PASSWORD は反映されず接続に失敗する
if $postgres_password_written && command -v docker >/dev/null; then
    project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')}"
    if docker volume inspect "${project}_postgres_data" >/dev/null 2>&1; then
        echo
        echo "警告: 既存のボリューム ${project}_postgres_data があります。" >&2
        echo "      新しい POSTGRES_PASSWORD は反映されないため、データが不要なら次で作り直してください:" >&2
        echo "      docker compose down -v" >&2
    fi
fi

echo
if [[ "$(current_value MAILER_SENDER_EMAIL || true)" == "Chatwoot <accounts@chatwoot.com>" ]]; then
    echo "メモ: MAILER_SENDER_EMAIL が初期値のままです。自社の送信元アドレスに変更してください"
fi
echo "完了: docker compose up -d で起動し、http://localhost:$(current_value CHATWOOT_PORT || echo "$CHATWOOT_PORT") を開いてください"
