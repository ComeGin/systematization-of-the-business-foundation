#!/usr/bin/env bash
# ローカル開発用: MySQL（Docker）のデータを削除し、Mautic をまっさらな状態から再インストールする
#
# 使い方: dev/reset.sh [-y|--yes] [--rotate-db-password] [--no-install]
#   -y, --yes               削除前の確認を省略する
#   --rotate-db-password    docker/.env の MYSQL_ROOT_PASSWORD / MYSQL_PASSWORD をランダム値に作り直す
#   --no-install            データ削除と MySQL 再起動までで止め、mautic:install とメール設定を実行しない
#
# 環境変数（未設定なら対話で入力。[ ] 内は Enter のみのときの既定値）:
#   MAUTIC_ADMIN_EMAIL, MAUTIC_ADMIN_USERNAME
#   MAUTIC_MAILER_FROM_NAME [Mautic], MAUTIC_MAILER_FROM_EMAIL [管理者メールアドレス]
#   MAUTIC_MAILER_REPLY_TO_EMAIL [なし], MAUTIC_MAILER_RETURN_PATH [なし]
#   MAUTIC_MAILER_HOST [127.0.0.1], MAUTIC_MAILER_PORT [1025], MAUTIC_MAILER_USER [なし]
#   MAUTIC_MAILER_PASSWORD（MAUTIC_MAILER_USER があるときだけ非表示で入力）
# 既定の SMTP 127.0.0.1:1025 は同梱の MailHog。受信したメールは http://localhost:8025 で確認する
# 管理者パスワードは履歴やファイルに残らないよう、常に非表示で対話入力する
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=docker/.env
COMPOSE=(docker compose -f docker/compose.yaml)
SITE_URL="${SITE_URL:-http://localhost:8000}"

assume_yes=false
rotate_db_password=false
run_install=true

for arg in "$@"; do
    case "$arg" in
        -y | --yes) assume_yes=true ;;
        --rotate-db-password) rotate_db_password=true ;;
        --no-install) run_install=false ;;
        -h | --help)
            sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "不明なオプション: $arg（--help を参照）" >&2
            exit 1
            ;;
    esac
done

if [[ $EUID -eq 0 ]]; then
    echo "root では実行しないでください（var/cache や config/local.php が root 所有になります）" >&2
    exit 1
fi

# env_value KEY DEFAULT: docker/.env から値を読む（未定義なら DEFAULT。compose.yaml の既定値と揃える）
env_value() {
    local value
    value="$({ grep "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2-)"
    echo "${value:-$2}"
}

# ask VAR PROMPT [DEFAULT]: 環境変数 VAR が未設定なら対話で入力させる（Enter のみなら DEFAULT）
ask() {
    local name=$1 prompt=$2 default=${3:-} input
    if [[ -n "${!name:-}" ]]; then
        return
    fi
    read -rp "${prompt}${default:+ [${default}]}: " input
    printf -v "$name" '%s' "${input:-$default}"
}

rotate_passwords() {
    sed -i \
        -e "s/^MYSQL_ROOT_PASSWORD=.*/MYSQL_ROOT_PASSWORD=$(openssl rand -hex 24)/" \
        -e "s/^MYSQL_PASSWORD=.*/MYSQL_PASSWORD=$(openssl rand -hex 24)/" \
        "$ENV_FILE"
    chmod 600 "$ENV_FILE"
}

if [[ ! -f "$ENV_FILE" ]]; then
    cp docker/.env.example "$ENV_FILE"
    rotate_db_password=true
fi

# 管理者情報とメール設定は削除前に集めておき、入力ミスで DB だけ消えた状態にならないようにする
if $run_install; then
    echo "--- 管理者"
    ask MAUTIC_ADMIN_EMAIL "管理者メールアドレス"
    ask MAUTIC_ADMIN_USERNAME "管理者ユーザー名"

    while true; do
        read -rsp "管理者パスワード: " admin_password
        echo
        read -rsp "管理者パスワード（確認）: " admin_password_confirm
        echo
        if [[ -z "$admin_password" ]]; then
            echo "パスワードが空です。" >&2
        elif [[ "$admin_password" != "$admin_password_confirm" ]]; then
            echo "パスワードが一致しません。" >&2
        else
            break
        fi
    done
    unset admin_password_confirm

    echo "--- メール送信設定（既定値は同梱の MailHog）"
    ask MAUTIC_MAILER_FROM_NAME "送信者名" "Mautic"
    ask MAUTIC_MAILER_FROM_EMAIL "送信元メールアドレス" "$MAUTIC_ADMIN_EMAIL"
    ask MAUTIC_MAILER_REPLY_TO_EMAIL "返信先アドレス（空なら送信元と同じ）"
    ask MAUTIC_MAILER_RETURN_PATH "バウンス用アドレス（空なら未設定）"
    ask MAUTIC_MAILER_HOST "SMTP ホスト" "127.0.0.1"
    ask MAUTIC_MAILER_PORT "SMTP ポート（465: SSL / 587: STARTTLS）" "1025"
    ask MAUTIC_MAILER_USER "SMTP ユーザー名（認証なしなら空）"
    if [[ -n "${MAUTIC_MAILER_USER:-}" && -z "${MAUTIC_MAILER_PASSWORD:-}" ]]; then
        read -rsp "SMTP パスワード: " MAUTIC_MAILER_PASSWORD
        echo
    fi
fi

if ! $assume_yes; then
    echo "MySQL ボリューム（mautic_mysql-data）を削除し、config/local.php を退避します。元に戻せません。"
    read -rp "続行しますか？ [y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]] || { echo "中止しました。"; exit 1; }
fi

echo "==> MySQL / MailHog のコンテナとボリュームを削除"
"${COMPOSE[@]}" down -v

if [[ -f config/local.php ]]; then
    backup="config/local.php.bak-$(date +%Y%m%d-%H%M%S)"
    mv config/local.php "$backup"
    echo "==> config/local.php を $backup に退避"
fi

echo "==> Symfony キャッシュを削除"
rm -rf var/cache/prod var/cache/dev

if $rotate_db_password; then
    echo "==> docker/.env の DB パスワードを再生成"
    rotate_passwords
fi

echo "==> MySQL / MailHog を起動（healthy になるまで待機）"
"${COMPOSE[@]}" up -d --wait

if ! $run_install; then
    echo "完了（--no-install のため mautic:install は未実行）"
    exit 0
fi

echo "==> Mautic をインストール"
php bin/console mautic:install "$SITE_URL" --force \
    --db_driver=pdo_mysql --db_host=127.0.0.1 --db_port="$(env_value MYSQL_PORT 3306)" \
    --db_name="$(env_value MYSQL_DATABASE mautic)" --db_user="$(env_value MYSQL_USER mautic)" \
    --db_password="$(env_value MYSQL_PASSWORD '')" \
    --admin_email="$MAUTIC_ADMIN_EMAIL" --admin_username="$MAUTIC_ADMIN_USERNAME" \
    --admin_password="$admin_password"
unset admin_password

echo "==> メール送信設定を config/local.php に書き込み"
# SMTP パスワードを引数に載せないよう、環境変数で渡す
export MAUTIC_MAILER_FROM_NAME MAUTIC_MAILER_FROM_EMAIL MAUTIC_MAILER_REPLY_TO_EMAIL MAUTIC_MAILER_RETURN_PATH \
    MAUTIC_MAILER_HOST MAUTIC_MAILER_PORT MAUTIC_MAILER_USER MAUTIC_MAILER_PASSWORD
php dev/configure-mailer.php
unset MAUTIC_MAILER_PASSWORD

# local.php の値はコンテナのコンパイル時に取り込まれるため、キャッシュを捨てて反映させる
rm -rf var/cache/prod var/cache/dev

echo "==> テストメールを ${MAUTIC_ADMIN_EMAIL} に送信"
if php bin/console mailer:test "$MAUTIC_ADMIN_EMAIL" --from="$MAUTIC_MAILER_FROM_EMAIL" \
    --subject="Mautic メール送信テスト" --body="dev/reset.sh からのテスト送信です。"; then
    [[ "$MAUTIC_MAILER_HOST:$MAUTIC_MAILER_PORT" == "127.0.0.1:1025" ]] && echo "MailHog で確認: http://localhost:8025"
else
    echo "警告: テストメールの送信に失敗しました。設定 > メール送信設定 で SMTP の値を確認してください。" >&2
fi

echo "完了: ${SITE_URL}/s/login"
