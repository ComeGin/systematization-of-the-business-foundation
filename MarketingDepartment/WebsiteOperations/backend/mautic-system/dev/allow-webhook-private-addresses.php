<?php

/*
 * config/local.php の webhook_allowed_private_addresses（設定 > Webhook 設定 の「許可する私設アドレス」と同じ項目）に、
 * Webhook の送り先のホストを足す。ローカル開発用（n8n の I-11 の送り先 http://127.0.0.1:5678 が私設アドレスのため）。
 *
 * Mautic 5 以降の WebhookBundle/Http/Client.php は、PrivateAddressChecker で私設アドレス（127.0.0.0/8・10.0.0.0/8 など）への
 * Webhook を拒む（webhook_logs に "Access to private addresses is not allowed."）。許可はこの配列に入れたホスト名か IP だけ。
 *
 *   MAUTIC_WEBHOOK_ALLOWED_PRIVATE_ADDRESSES   必須。カンマ区切りのホスト名か IP（例: 127.0.0.1）
 *
 * 既にある値は消さずに足すだけ（冪等）。変えたときだけ "changed"、変えなかったときは "unchanged" を出す。
 * 書いた後は Symfony のコンテナのキャッシュ（var/cache）を捨てないと反映されない（呼び出し側で行う）。
 */

$root       = dirname(__DIR__);
$configFile = $root.'/config/local.php';
if (!is_file($configFile)) {
    fwrite(STDERR, "config/local.php がありません。先に mautic:install を実行してください。\n");
    exit(1);
}

$wanted = array_values(array_filter(array_map('trim', explode(',', (string) getenv('MAUTIC_WEBHOOK_ALLOWED_PRIVATE_ADDRESSES')))));
if ([] === $wanted) {
    fwrite(STDERR, "MAUTIC_WEBHOOK_ALLOWED_PRIVATE_ADDRESSES が空です\n");
    exit(1);
}
foreach ($wanted as $host) {
    if (!filter_var($host, FILTER_VALIDATE_IP) && !preg_match('/^[a-z0-9.-]+$/i', $host)) {
        fwrite(STDERR, "ホスト名か IP ではありません: {$host}\n");
        exit(1);
    }
}

$parameters = [];
require $configFile;

$current = $parameters['webhook_allowed_private_addresses'] ?? [];
$current = is_array($current) ? array_values($current) : [];
$merged  = array_values(array_unique(array_merge($current, array_map('strtolower', $wanted))));
if ($merged === $current) {
    echo "unchanged\n";
    exit(0);
}
$parameters['webhook_allowed_private_addresses'] = $merged;

// configure-mailer.php と同じ形で書き戻す（local.php に既にある値はエスケープ済みなので、そのまま var_export する）
$lines = [];
foreach ($parameters as $key => $value) {
    $lines[] = "\t".var_export($key, true).' => '.var_export($value, true).',';
}

$tmp = $configFile.'.tmp';
file_put_contents($tmp, "<?php\n\$parameters = array(\n".implode("\n", $lines)."\n);\n");
rename($tmp, $configFile);

echo "changed\n";
