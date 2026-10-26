#!/bin/bash
# 派生イメージの entrypoint。公式の /entrypoint.sh の前に 1 つだけ処理を足し、あとは公式に任せる（exec）。
#
# 足す処理: 環境変数 MAUTIC_TRUSTED_PROXIES（JSON の配列。例 ["10.20.0.0/16"]）から、
# config/parameters_local.php に trusted_proxies を書く。
#   Mautic が信頼するプロキシ（Request::setTrustedProxies）は、TrustMiddleware が config/local.php と
#   config/parameters_local.php からしか読まない（app/middlewares/TrustMiddleware.php・ConfigAwareTrait.php）。
#   環境変数だけでは効かず、ALB 越しの要求が http・送信元は ALB の IP と判定される（インストーラーが site_url を http:// で保存するなど）。
#   config は EFS で覆うので、イメージに焼いても見えない。起動のたびに書く（値の正は ECS のタスク定義の環境変数）。
#   local.php は人の操作（インストーラー・管理画面の設定）が書くので触らない。parameters_local.php は local.php より優先される。
set -euo pipefail

config_dir="${MAUTIC_VOLUME_CONFIG:-/var/www/html/config}"
target="${config_dir}/parameters_local.php"

if [ -n "${MAUTIC_TRUSTED_PROXIES:-}" ]; then
  # 値は JSON として検査してから PHP の配列として書く（壊れた値で Mautic を起動させない）
  php -r '
    $v = json_decode(getenv("MAUTIC_TRUSTED_PROXIES"), true);
    if (!is_array($v) || $v === [] || array_filter($v, fn ($x) => !is_string($x) || $x === "") !== []) {
      fwrite(STDERR, "comegin-entrypoint: MAUTIC_TRUSTED_PROXIES が文字列の JSON 配列ではない\n");
      exit(1);
    }
    $php = "<?php\n// comegin-entrypoint.sh が起動のたびに書く（MAUTIC_TRUSTED_PROXIES から）。手で直さない。\n"
         . "\$parameters = [\x27trusted_proxies\x27 => " . var_export(array_values($v), true) . "];\n";
    file_put_contents($argv[1] . ".tmp", $php);
  ' "$target"
  mv "${target}.tmp" "$target"
  chown "${MAUTIC_WWW_USER:-www-data}:${MAUTIC_WWW_GROUP:-www-data}" "$target"
  chmod 0640 "$target"
  echo "comegin-entrypoint: ${target} に trusted_proxies を書いた"
fi

exec /entrypoint.sh "$@"
