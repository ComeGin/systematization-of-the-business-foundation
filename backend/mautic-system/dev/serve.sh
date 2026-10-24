#!/usr/bin/env bash
# ローカル開発用: MySQL（Docker）を起動し、PHP ビルトインサーバーで Mautic を配信する
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

# healthcheck が healthy になるまで待つ
docker compose -f docker/compose.yaml up -d --wait

# Webhook のキュー（queue_mode = command_process。dev/queue-webhooks.php）を定期に送る。本番の mautic-cron の代わり（TA-06 の 3.1）。
# 未インストールの間や immediate_process のときは、コマンドが何もせずに終わるだけ。
WEBHOOK_INTERVAL="${WEBHOOK_INTERVAL:-60}"
(
    while sleep "${WEBHOOK_INTERVAL}"; do
        php bin/console mautic:webhooks:process --no-interaction >/dev/null || echo "mautic:webhooks:process が失敗しました（${WEBHOOK_INTERVAL} 秒後に再実行）" >&2
    done
) &
webhook_loop=$!
trap 'kill "${webhook_loop}" 2>/dev/null' EXIT

echo "Mautic: http://localhost:${PORT}/s/login  (Ctrl+C か dev/stop.sh で停止。Webhook は ${WEBHOOK_INTERVAL} 秒ごとに送る)"
# ダッシュボードは Ajax を並列に投げるため、ワーカーを複数にする
# （exec にしない。終了時に trap で Webhook の定期実行も止めるため）
PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-4}" php -S "${HOST}:${PORT}" -t . dev/router.php
