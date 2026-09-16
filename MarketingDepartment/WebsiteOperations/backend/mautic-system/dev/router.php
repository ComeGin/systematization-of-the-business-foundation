<?php

/*
 * PHP ビルトインサーバー（php -S）用のルーター。ローカル開発専用。
 * Apache の .htaccess 群と同様に機密ファイルを配信せず、実在する静的ファイル以外は index.php に渡す。
 */

$root = dirname(__DIR__);
$path = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));

$denied = '#(^|/)\.'                                                   // .env, .git などのドットファイル
    .'|^/(composer\.(json|lock)|package(-lock)?\.json)$'
    .'|^/(app(?!/assets/)|bin|config|dev|docker|media/files|node_modules|translations|var|vendor)(/|$)#';

if (preg_match($denied, $path)) {
    http_response_code(404);

    return true;
}

if ('/' !== $path && !str_ends_with($path, '.php') && is_file($root.$path)) {
    return false; // 静的ファイルはビルトインサーバーにそのまま配信させる
}

// Symfony がベース URL を "" と判定できるよう、フロントコントローラー経由のリクエストに見せる
$_SERVER['SCRIPT_NAME']     = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root.'/index.php';

require $root.'/index.php';
