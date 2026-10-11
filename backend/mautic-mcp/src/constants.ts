export const SERVER_NAME = "mautic-mcp-server";
export const SERVER_VERSION = "0.3.0";

/** ツール応答の最大文字数。超えた場合は件数を減らして返す */
export const CHARACTER_LIMIT = 25_000;

/** これより長い文字列（メール本文の HTML など）は、明示されない限り省略して返す */
export const LONG_TEXT_LIMIT = 1_000;

/** Mautic への HTTP リクエストのタイムアウト */
export const HTTP_TIMEOUT_MS = 30_000;

/** アクセストークンの有効期限がこの秒数未満になったら再取得する */
export const TOKEN_REFRESH_MARGIN_SEC = 60;

/** 固定トークン認証で AuthInfo に設定する有効期限（SDK が expiresAt を必須とするため） */
export const STATIC_TOKEN_TTL_SEC = 3600;
