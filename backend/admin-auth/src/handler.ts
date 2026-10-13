import { AUTH_BASE_PATH, CONSENT_PATH, ERROR_PATH, HEALTH_PATH, SIGN_IN_PATH } from "./constants.js";
import { consentPage, errorPage, type Page, signInPage } from "./pages.js";

/** 入口に依存しない本体の型。開発は server.ts（toNodeHandler）、本番は lambda.ts（ALB のイベント）が Request を作る */
export type Handle = (req: Request) => Promise<Response>;

export interface HandlerDeps {
  auth: { handler: (req: Request) => Promise<Response> };
}

const ROOT_WELL_KNOWN_PATHS = new Set(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]);

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

const page = (p: Page): Response =>
  new Response(p.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": p.csp,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });

/**
 * 管理画面の関門の本体（仕様 3.1）。振り分けは以前の index.ts と同じ。例外を投げない（想定外の失敗は 500）。
 * ログは 1 件 1 行（時刻・メソッド・パス・ステータス・所要時間）。クエリ（認可コードや署名）とメールは出さない
 */
export function createHandler({ auth }: HandlerDeps): Handle {
  const route = async (req: Request, url: URL): Promise<Response> => {
    const isRead = req.method === "GET" || req.method === "HEAD";
    // ヘルスチェック。DB は見ない（開発用。本番の ALB ではヘルスチェックを使わない）
    if (url.pathname === HEALTH_PATH && isRead) return text(200, "ok");

    let target = req;
    // ルート直下の discovery は、issuer（/api/auth）配下の同じ内容への別名として返す
    if (isRead && ROOT_WELL_KNOWN_PATHS.has(url.pathname)) {
      url.pathname = `${AUTH_BASE_PATH}${url.pathname}`;
      target = new Request(url, req);
    }

    // Better Auth（認可・トークン・UserInfo・JWKS・ソーシャルログインのコールバック・discovery）。
    // RFC 8414 のパスを issuer の後ろに付ける形（/.well-known/oauth-authorization-server/api/auth）も同じハンドラーが返す
    if (url.pathname.startsWith(`${AUTH_BASE_PATH}/`) || url.pathname.startsWith("/.well-known/")) {
      try {
        return await auth.handler(target);
      } catch (error) {
        console.error("[auth] unhandled error", error);
        return text(500, "internal error");
      }
    }

    if (isRead && url.pathname === SIGN_IN_PATH) return page(signInPage());
    if (isRead && url.pathname === CONSENT_PATH) return page(consentPage());
    if (isRead && url.pathname === ERROR_PATH) return page(errorPage(url.searchParams.get("error")));
    return text(404, "not found");
  };

  return async (req) => {
    const startedAt = Date.now();
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, url);
    } catch (error) {
      console.error("[server] unexpected error", error);
      res = text(500, "internal error");
    }
    // クエリ（認可コードや署名を含む）は記録しない。付け替えたときは付け替え後のパス
    console.error(
      JSON.stringify({ t: new Date().toISOString(), method: req.method, path: url.pathname, status: res.status, ms: Date.now() - startedAt }),
    );
    return res;
  };
}
