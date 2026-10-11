// Route Handler の共通処理: ログイン確認 → control-plane の取得 → 例外の整理。
import type { ControlPlane } from "control-plane";
import { getControlPlaneState } from "./control-plane";
import { guardApiRequest } from "./session";

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
