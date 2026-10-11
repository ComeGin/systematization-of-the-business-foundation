<?php

/*
 * config/local.php の queue_mode（設定 > Webhook 設定 の「キューモード」と同じ項目）を command_process にする。
 * 開発も本番も同じ値にする（本番は mautic-cron が mautic:webhooks:process を定期に実行する。TA-06 の 3.1）。
 *
 * 既定の immediate_process では、WebhookModel が Webhook をフォームの送信などの要求の中でそのまま送る。送り先（n8n の I-11）が
 * 遅いと、公開サイトのフォームの応答がその分だけ遅れ（1 回の送信で lead_post_save_new・lead_post_save_update・form_on_submit の
 * 最大 3 回、各 webhook_timeout 秒まで待つ）、画面の 10 秒の打ち切りで「応答がありませんでした」になる（2026-10-11 に開発で発生）。
 * command_process では要求の中ではキューに積むだけで、送るのは mautic:webhooks:process。失敗した分はキューに残り、次の回に送り直す。
 *
 * 既に command_process なら何もしない（冪等）。変えたときだけ "changed"、変えなかったときは "unchanged" を出す。
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

if ('command_process' === ($parameters['queue_mode'] ?? null)) {
    echo "unchanged\n";
    exit(0);
}
$parameters['queue_mode'] = 'command_process';

// disable-webhook-auto-unpublish.php と同じ形で書き戻す
$lines = [];
foreach ($parameters as $key => $value) {
    $lines[] = "\t".var_export($key, true).' => '.var_export($value, true).',';
}

$tmp = $configFile.'.tmp';
file_put_contents($tmp, "<?php\n\$parameters = array(\n".implode("\n", $lines)."\n);\n");
rename($tmp, $configFile);

echo "changed\n";
