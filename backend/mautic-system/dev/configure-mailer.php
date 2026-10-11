<?php

/*
 * config/local.php に Mautic のメール設定（設定 > メール送信設定 と同じ項目）を書き込む。ローカル開発用。
 * 値はコマンドライン引数に載せないよう環境変数で受け取る（ps から SMTP パスワードが見えないようにする）。
 *
 *   MAUTIC_MAILER_FROM_NAME, MAUTIC_MAILER_FROM_EMAIL           必須
 *   MAUTIC_MAILER_HOST, MAUTIC_MAILER_PORT                      必須（SMTP）
 *   MAUTIC_MAILER_USER, MAUTIC_MAILER_PASSWORD                  任意
 *   MAUTIC_MAILER_REPLY_TO_EMAIL, MAUTIC_MAILER_RETURN_PATH     任意
 */

use Mautic\CoreBundle\Helper\Dsn\Dsn;

$root = dirname(__DIR__);
require $root.'/vendor/autoload.php';

$configFile = $root.'/config/local.php';
if (!is_file($configFile)) {
    fwrite(STDERR, "config/local.php がありません。先に mautic:install を実行してください。\n");
    exit(1);
}

$env = static fn (string $name): ?string => ('' === ($value = (string) getenv($name))) ? null : $value;

$fromName  = $env('MAUTIC_MAILER_FROM_NAME');
$fromEmail = $env('MAUTIC_MAILER_FROM_EMAIL');
$host      = $env('MAUTIC_MAILER_HOST');
$port      = $env('MAUTIC_MAILER_PORT');
$replyTo   = $env('MAUTIC_MAILER_REPLY_TO_EMAIL');
$returnTo  = $env('MAUTIC_MAILER_RETURN_PATH');

$errors = [];
if (null === $fromName) {
    $errors[] = 'MAUTIC_MAILER_FROM_NAME が空です';
}
foreach (['MAUTIC_MAILER_FROM_EMAIL' => $fromEmail, 'MAUTIC_MAILER_REPLY_TO_EMAIL' => $replyTo, 'MAUTIC_MAILER_RETURN_PATH' => $returnTo] as $name => $email) {
    if (null !== $email && false === filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $errors[] = "{$name} がメールアドレスの形式ではありません: {$email}";
    }
}
if (null === $fromEmail) {
    $errors[] = 'MAUTIC_MAILER_FROM_EMAIL が空です';
}
if (null === $host) {
    $errors[] = 'MAUTIC_MAILER_HOST が空です';
}
if (null === $port || !ctype_digit($port)) {
    $errors[] = 'MAUTIC_MAILER_PORT は数値で指定してください';
}
if ($errors) {
    fwrite(STDERR, implode("\n", $errors)."\n");
    exit(1);
}

// Mautic の設定画面と同じく、Dsn クラスでユーザー名・パスワードを URL エンコードする
$dsn = (string) new Dsn('smtp', $host, $env('MAUTIC_MAILER_USER'), $env('MAUTIC_MAILER_PASSWORD'), (int) $port);

$parameters = [];
require $configFile;

// % は Symfony のパラメータ参照と解釈されるため、設定画面（EscapeTransformer）と同様に %% へエスケープする。
// local.php に既にある値はエスケープ済みなので、ここで追加する値だけを対象にする
$mailer = array_map(
    static fn (?string $value): ?string => null === $value ? null : str_replace('%', '%%', $value),
    [
        'mailer_dsn'            => $dsn,
        'mailer_from_name'      => $fromName,
        'mailer_from_email'     => $fromEmail,
        'mailer_reply_to_email' => $replyTo,
        'mailer_return_path'    => $returnTo,
    ]
);

$lines = [];
foreach (array_merge($parameters, $mailer) as $key => $value) {
    $lines[] = "\t".var_export($key, true).' => '.var_export($value, true).',';
}

$tmp = $configFile.'.tmp';
file_put_contents($tmp, "<?php\n\$parameters = array(\n".implode("\n", $lines)."\n);\n");
rename($tmp, $configFile);

echo "config/local.php にメール設定を書き込みました（smtp://{$host}:{$port}）\n";
