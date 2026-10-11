export const SERVER_NAME = "chatwoot-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** ツール応答の最大文字数。超えた場合は件数を減らす・切り詰めて返す */
export const CHARACTER_LIMIT = 25_000;

/** これより長い文字列（メール本文など）は、明示されない限り省略して返す */
export const LONG_TEXT_LIMIT = 1_000;

/** Chatwoot への HTTP リクエストのタイムアウト */
export const HTTP_TIMEOUT_MS = 30_000;

/** Chatwoot 側で固定されている 1 ページあたりの件数（サーバの設定で変更されていない前提） */
export const PAGE_SIZE = {
  conversations: 25,
  contacts: 15,
  reportingEvents: 25,
  auditLogs: 25,
} as const;

/** 固定トークン認証で AuthInfo に設定する有効期限（SDK が expiresAt を必須とするため） */
export const STATIC_TOKEN_TTL_SEC = 3600;
