// セッションの確認。Route Handler と Server Component の両方で、必ずここを通す（ログイン必須）。
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ensureAuthSchema, getAuth, isAdminEmail } from "./auth";

/**
 * ログイン中のセッション。無ければ null。
 * 許可リストは要求ごとに確かめる。外された人（ドメイン外を含む）のセッションはその場で失効させ、未ログインと同じ null を返す
 * （ユーザーとセッションの作成時の検査〈lib/auth.ts の databaseHooks〉だけでは、作成済みのセッションが使うたびに延長されて残り続けるため）。
 */
export async function getSession() {
  // 先に headers() を読む。next build の静的化の試行で動的な要求と判定させ、ビルド中に DB を開かないようにする
  const requestHeaders = await headers();
  await ensureAuthSchema();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session || isAdminEmail(session.user.email)) return session;
  // メールアドレスは記録しない（auth.ts の拒否と同じ）
  console.error("[auth] session revoked: email is not on the allowlist");
  try {
    await (await auth.$context).internalAdapter.deleteSession(session.session.token);
  } catch {
    // 失効に失敗しても通さない（次の要求でもう一度ここに来る）
    console.error("[auth] failed to revoke the session");
  }
  return null;
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
