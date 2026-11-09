import type { NextRequest } from "next/server";
import * as z from "zod";
import { withControlPlaneActor } from "@/lib/api";
import { ULID } from "@/lib/ids";

// 項目への操作。actor は本文に含めない（セッションから決める）。
// approve の checked は確認項目の id の集合（control-plane が項目の確認項目と過不足なく一致するかを検査する）。
// expectedUpdatedAt は画面で見た項目の updatedAt（受け取ったまま返す。確認の後に中身が差し替わっていれば control-plane が 400 にする）
const ItemActionBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    checked: z.array(z.string().min(1).max(100)).max(50),
    expectedUpdatedAt: z.string().min(1).max(64),
  }),
  z.object({ action: z.literal("reject"), reason: z.string().min(1).max(500) }),
  z.object({ action: z.literal("execute") }),
]);

/** OK・差し戻し・「実行した」。OK と差し戻しは更新後の周を、「実行した」は { accepted } を返す。契約の検査の失敗（ControlPlaneInputError）は 400 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/cycle/items/[itemId]">) {
  const { itemId } = await ctx.params;
  return withControlPlaneActor(request, async (plane, actor) => {
    if (!ULID.test(itemId)) return Response.json({ error: "invalid item id" }, { status: 400 });
    const body = ItemActionBody.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid body" }, { status: 400 });
    switch (body.data.action) {
      case "approve":
        return Response.json(await plane.approveCycleItem(itemId, body.data.checked, actor, body.data.expectedUpdatedAt));
      case "reject":
        return Response.json(await plane.rejectCycleItem(itemId, body.data.reason, actor));
      case "execute": {
        const result = await plane.markCycleItemExecuted(itemId, actor);
        return Response.json(result, { status: result.accepted ? 202 : 200 });
      }
    }
  });
}
