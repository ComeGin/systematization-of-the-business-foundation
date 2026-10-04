// セッションの確認。Route Handler と Server Component の両方で、必ずここを通す（ログイン必須）。
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ensureAuthSchema, getAuth } from "./auth";

export async function getSession() {
  // 先に headers() を読む。next build の静的化の試行で動的な要求と判定させ、ビルド中に DB を開かないようにする
  const requestHeaders = await headers();
  await ensureAuthSchema();
  return getAuth().api.getSession({ headers: requestHeaders });
}

/** ページ用。ログインしていなければ /login へ。 */
export async function requirePageSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Route Handler 用。許可できないときは返すべき Response、許可できるときは null。
 *  - ログイン必須（401）
 *  - 状態を変える要求は、同じオリジンからだけ受ける（403。ブラウザからの別サイト経由の要求を防ぐ）
 */
export async function guardApiRequest(request: Request): Promise<Response | null> {
  let session;
  try {
    session = await getSession();
  } catch {
    return Response.json({ error: "authentication is unavailable" }, { status: 503 });
  }
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (!origin || !host) return Response.json({ error: "origin is required" }, { status: 403 });
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return Response.json({ error: "invalid origin" }, { status: 403 });
    }
    if (originHost !== host) return Response.json({ error: "cross-origin request" }, { status: 403 });
  }
  return null;
}
