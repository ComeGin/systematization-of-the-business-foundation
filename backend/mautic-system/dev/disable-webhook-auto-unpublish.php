<?php

/*
 * config/local.php の disable_auto_unpublish（設定 > Webhook 設定 の「失敗が続いても自動で非公開にしない」と同じ項目）を true にする。
 * ローカル開発用。本番には使わない（本番は false のまま。失敗が続いた Webhook は止まり、n8n の provision で公開に戻す）。
 *
 * Mautic の WebhookModel::processWebhook は、送信に失敗して isSick（直近 webhook_disable_limit 件の成功と失敗の比）になった Webhook を
 * killWebhook で非公開にする。開発では n8n の I-11 が未公開（404）なのが既定なので、コンタクトが 1 回変わるだけで「n8n I-11」が止まる。
 *
 * 既に true なら何もしない（冪等）。変えたときだけ "changed"、変えなかったときは "unchanged" を出す。
 * 書いた後は Symfony のコンテナのキャッシュ（var/cache）を捨てないと反映されない（呼び出し側で行う）。
 */

$root       = dirname(__DIR__);
$configFile = $root.'/config/local.php';
if (!is_file($configFile)) {
    fwrite(STDERR, "config/local.php がありません。先に mautic:install を実行してください。\n");
    exit(1);
}

$parameters = [];
require $configFile;

if (true === ($parameters['disable_auto_unpublish'] ?? null)) {
    echo "unchanged\n";
    exit(0);
}
$parameters['disable_auto_unpublish'] = true;

// allow-webhook-private-addresses.php・configure-mailer.php と同じ形で書き戻す
$lines = [];
foreach ($parameters as $key => $value) {
    $lines[] = "\t".var_export($key, true).' => '.var_export($value, true).',';
}

$tmp = $configFile.'.tmp';
file_put_contents($tmp, "<?php\n\$parameters = array(\n".implode("\n", $lines)."\n);\n");
rename($tmp, $configFile);

echo "changed\n";
