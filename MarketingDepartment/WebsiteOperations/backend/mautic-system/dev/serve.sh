#!/usr/bin/env bash
# ローカル開発用: MySQL（Docker）を起動し、PHP ビルトインサーバーで Mautic を配信する
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

# healthcheck が healthy になるまで待つ
docker compose -f docker/compose.yaml up -d --wait

echo "Mautic: http://localhost:${PORT}/s/login  (Ctrl+C で停止)"
# ダッシュボードは Ajax を並列に投げるため、ワーカーを複数にする
PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-4}" exec php -S "${HOST}:${PORT}" -t . dev/router.php
