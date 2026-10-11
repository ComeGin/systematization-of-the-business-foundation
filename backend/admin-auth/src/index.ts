import http from "node:http";
import { toNodeHandler } from "better-auth/node";
import { bootstrapAllowlist } from "./allowlist.js";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  AUTH_BASE_PATH,
  CONSENT_PATH,
  ERROR_PATH,
  HEADERS_TIMEOUT_MS,
  HEALTH_PATH,
  KEEP_ALIVE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  SERVER_NAME,
  SHUTDOWN_TIMEOUT_MS,
  SIGN_IN_PATH,
} from "./constants.js";
import { createPool } from "./db.js";
import { consentPage, errorPage, signInPage, type Page } from "./pages.js";

const config = loadConfig();
const pool = createPool(config);

// 許可リストの表は db:migrate が作る。表が無い・DB に届かないときは、起動を止めて原因を出す
try {
  const added = await bootstrapAllowlist(pool, config.ADMIN_BOOTSTRAP_EMAILS);
  console.error(`[${SERVER_NAME}] allowlist bootstrap: ${added} added`);
} catch (error) {
  console.error(`[${SERVER_NAME}] cannot reach the allowlist table (run db:migrate first): ${(error as Error).message}`);
  process.exit(1);
}

const auth = createAuth(config, pool);
const authHandler = toNodeHandler(auth);

function sendPage(res: http.ServerResponse, page: Page): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": page.csp,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(page.html);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const ROOT_WELL_KNOWN_PATHS = new Set(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]);

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    // クエリ（認可コードや署名を含む）は記録しない
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - startedAt,
      }),
    );
  });

  // 解釈できないリクエストターゲット（例 `//[`）で new URL() が投げると、未捕捉の例外でプロセスが落ちるため null で受ける
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) return sendText(res, 400, "bad request");
  const { pathname } = url;
  const isRead = req.method === "GET" || req.method === "HEAD";

  // ALB のターゲットのヘルスチェック。DB は見ない（DB の瞬断でタスクが外れ、新しいログインだけでなく既存の管理画面まで巻き込むのを避ける）
  if (pathname === HEALTH_PATH && isRead) return sendText(res, 200, "ok");

  // ルート直下の discovery は、issuer（/api/auth）配下の同じ内容への別名として返す
  if (isRead && ROOT_WELL_KNOWN_PATHS.has(pathname)) req.url = `${AUTH_BASE_PATH}${pathname}${url.search}`;

  // Better Auth（認可・トークン・UserInfo・JWKS・ソーシャルログインのコールバック・discovery）。
  // RFC 8414 のパスを issuer の後ろに付ける形（/.well-known/oauth-authorization-server/api/auth）も同じハンドラーが返す
  if (req.url?.startsWith(`${AUTH_BASE_PATH}/`) || pathname.startsWith("/.well-known/")) {
    authHandler(req, res).catch((error: unknown) => {
      console.error("[auth] unhandled error", error);
      if (!res.headersSent) sendText(res, 500, "internal error");
      else res.end();
    });
    return;
  }

  if (isRead && pathname === SIGN_IN_PATH) return sendPage(res, signInPage());
  if (isRead && pathname === CONSENT_PATH) return sendPage(res, consentPage());
  if (isRead && pathname === ERROR_PATH) return sendPage(res, errorPage(url.searchParams.get("error")));

  sendText(res, 404, "not found");
});

server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;

server.listen(config.PORT, config.HOST, () => {
  console.error(`[${SERVER_NAME}] listening on ${config.HOST}:${config.PORT} (issuer ${config.BETTER_AUTH_URL}${AUTH_BASE_PATH})`);
});

// ECS の停止（SIGTERM）では、処理中のリクエストを終えてから DB を閉じる
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${SERVER_NAME}] ${signal} received, shutting down`);
  const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forced.unref();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
