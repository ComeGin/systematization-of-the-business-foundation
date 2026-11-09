// Route Handler の共通処理: ログイン確認 → control-plane の取得 → 例外の整理。
import type { ControlPlane } from "control-plane";
import { getControlPlaneState } from "./control-plane";
import { getSession, guardApiRequest } from "./session";

export async function withControlPlane(
  request: Request,
  handler: (plane: ControlPlane) => Promise<Response>,
): Promise<Response> {
  const denied = await guardApiRequest(request);
  if (denied) return denied;

  const state = getControlPlaneState();
  if (!state.plane) return Response.json({ error: state.error }, { status: 503 });

  try {
    return await handler(state.plane);
  } catch (error) {
    // instanceof ではなく name で判定する（外部パッケージが読み込みの経路によって別のコピーになりうるため）
    if (error instanceof Error && error.name === "ControlPlaneInputError") {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error(`- ERROR api ${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? error.message : "不明"}`);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

/**
 * withControlPlane に、操作した人（セッションのメール）を渡す版。actor はサーバー側でセッションから決める（クライアントの申告は使わない）。
 * 改善ループの承認など、「だれが」を記録する操作で使う。
 */
export async function withControlPlaneActor(
  request: Request,
  handler: (plane: ControlPlane, actor: string) => Promise<Response>,
): Promise<Response> {
  return withControlPlane(request, async (plane) => {
    const session = await getSession();
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
    return handler(plane, session.user.email);
  });
}
