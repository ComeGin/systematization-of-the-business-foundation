import type { CycleStage } from "control-plane";
import type { NextRequest } from "next/server";
import { withControlPlaneActor } from "@/lib/api";

const STAGES: readonly CycleStage[] = ["collect", "propose", "draft", "review", "publish", "evaluate", "deploy"];

/**
 * 段階（①〜⑦）の「今すぐ実行」。段階のジョブを順に 1 本ずつ起動する（完了は待たない）。actor はセッションから決める。
 * 受け付けたら 202、実行中・ジョブの無い段階は 200 で { accepted: false, reason }
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/cycle/stages/[stage]">) {
  const { stage } = await ctx.params;
  return withControlPlaneActor(request, async (plane, actor) => {
    if (!(STAGES as readonly string[]).includes(stage)) return Response.json({ error: "invalid stage" }, { status: 400 });
    const result = await plane.runCycleStage(stage as CycleStage, actor);
    return Response.json(result, { status: result.accepted ? 202 : 200 });
  });
}
