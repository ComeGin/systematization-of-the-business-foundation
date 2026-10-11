<?php

/*
 * config/local.php の cors_valid_domains（設定 > システム設定 > CORS 設定 の「有効なドメイン」と同じ項目）に、
 * 公開サイトのオリジンを足す。ローカル開発用（公開サイト〈Astro〉のフォームはブラウザから /form/submit へ直接送るため）。
 *
 * app/middlewares/CORSMiddleware.php は、cors_restrict_domains が真（既定）のとき、cors_valid_domains にあるオリジンにだけ
 * Access-Control-Allow-Origin を返す。プリフライト（OPTIONS）は Access-Control-Request-Headers があるときだけ、
 * 本体の応答は X-Requested-With: XMLHttpRequest が付いた要求にだけ CORS のヘッダーを付ける。
 * 許可が無いと、ブラウザは応答を読めず、公開サイトは「送信できませんでした」を出す。
 *
 *   MAUTIC_CORS_VALID_DOMAINS   必須。カンマ区切りのオリジン（例: http://localhost:4321,https://comegin-astro-dev.ngrok.app）
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

$wanted = array_values(array_filter(array_map('trim', explode(',', (string) getenv('MAUTIC_CORS_VALID_DOMAINS')))));
if ([] === $wanted) {
    fwrite(STDERR, "MAUTIC_CORS_VALID_DOMAINS が空です\n");
    exit(1);
}
foreach ($wanted as $origin) {
    // ブラウザが送る Origin と文字列で比べられるので、スキーム・ホスト・ポートだけ（末尾のスラッシュやパスは付けない）
    if (!preg_match('#^https?://[a-z0-9.-]+(:\d+)?$#i', $origin)) {
        fwrite(STDERR, "オリジンではありません（https://host[:port] の形）: {$origin}\n");
        exit(1);
    }
}

$parameters = [];
require $configFile;

$current = $parameters['cors_valid_domains'] ?? [];
$current = is_array($current) ? array_values($current) : [];
$merged  = array_values(array_unique(array_merge($current, array_map('strtolower', $wanted))));
if ($merged === $current) {
    echo "unchanged\n";
    exit(0);
}
$parameters['cors_valid_domains'] = $merged;

// allow-webhook-private-addresses.php と同じ形で書き戻す（local.php に既にある値はエスケープ済みなので、そのまま var_export する）
$lines = [];
foreach ($parameters as $key => $value) {
    $lines[] = "\t".var_export($key, true).' => '.var_export($value, true).',';
}

$tmp = $configFile.'.tmp';
file_put_contents($tmp, "<?php\n\$parameters = array(\n".implode("\n", $lines)."\n);\n");
rename($tmp, $configFile);

echo "changed\n";
