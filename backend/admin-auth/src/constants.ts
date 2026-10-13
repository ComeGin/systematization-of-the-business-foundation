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

// Lambda の入口（lambda.ts。仕様 3.4）。1 つの実行環境が同時に処理するのは 1 件だけだが、Better Auth は 1 件の中で問い合わせを並べることがある
export const LAMBDA_DB_POOL_MAX = 2;
// 凍結のあとの死んだ接続で問い合わせが固まらないようにする保険
export const DB_QUERY_TIMEOUT_MS = 5_000;
// これ以上アイドルが続いたら、処理の前にプールと auth を作り直す（ALB の IdP の呼び出しの一連の流れ〈数秒〉では作り直さない長さ）
export const LAMBDA_IDLE_RECYCLE_MS = 60_000;

// 開発の入口（server.ts）だけが使う。以前の ECS では ALB のアイドルタイムアウト（既定 60 秒）より長くする必要があった
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export const SHUTDOWN_TIMEOUT_MS = 10_000;
