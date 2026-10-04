export const SERVER_NAME = "consent-api";

// 同意の Cookie（DD-02 の 8.2、01-content-spec.md の 8.1.1）
export const COOKIE_NAME = "comegin_consent";
export const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60; // 12 か月

// サーバーが発行する識別子: 128 ビットの乱数を base64url にした 22 文字
export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export const CONSENT_PATH = "/v1/consent";
export const HEALTH_PATH = "/healthz";

export const MAX_BODY_BYTES = 1024;

// 1 つの識別子に積める記録の上限。Cookie を持ち回った連打で Stream が際限なく伸びるのを防ぐ。
// 超えた分はトリミングせず 429 で拒否するため、すでにある記録は消えない
export const MAX_RECORDS_PER_ID = 200;

export const VALKEY_COMMAND_TIMEOUT_MS = 2_000;
export const VALKEY_CONNECT_TIMEOUT_MS = 3_000;

// ALB のアイドルタイムアウト（既定 60 秒）より長くする。短いと ALB が再利用した接続を先に切られて 502 になる
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;
export const REQUEST_TIMEOUT_MS = 15_000;

export const SHUTDOWN_TIMEOUT_MS = 10_000;
