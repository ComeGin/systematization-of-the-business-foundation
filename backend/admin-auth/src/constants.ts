export const SERVER_NAME = "admin-auth";

// Better Auth の既定の basePath。issuer は ${BETTER_AUTH_URL}${AUTH_BASE_PATH}
export const AUTH_BASE_PATH = "/api/auth";

export const HEALTH_PATH = "/healthz";
export const SIGN_IN_PATH = "/sign-in";
export const CONSENT_PATH = "/consent";
export const ERROR_PATH = "/error";

// 許可リストの表（Better Auth の表とは別に、このサービスが持つ）
export const ALLOWLIST_TABLE = "admin_allowlist";

// admin-auth 自身のセッション。ALB のセッション（12 時間）とそろえる
export const SESSION_EXPIRES_IN_SECONDS = 12 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

// ALB が要求する scope。access token を UserInfo に送るため email と profile も付ける
export const OIDC_SCOPES = ["openid", "profile", "email"];

export const DB_POOL_MAX = 10;
export const DB_CONNECT_TIMEOUT_MS = 5_000;

// ALB のアイドルタイムアウト（既定 60 秒）より長くする
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export const SHUTDOWN_TIMEOUT_MS = 10_000;
