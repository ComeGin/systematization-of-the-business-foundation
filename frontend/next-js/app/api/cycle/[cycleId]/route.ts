import type { NextRequest } from "next/server";
import { withControlPlane } from "@/lib/api";
import { CYCLE_ID } from "@/lib/ids";

/** 指定した周（C-YYYY-MM-DD） */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/cycle/[cycleId]">) {
  const { cycleId } = await ctx.params;
  return withControlPlane(request, async (plane) => {
    if (!CYCLE_ID.test(cycleId)) return Response.json({ error: "invalid cycle id" }, { status: 400 });
    return Response.json(await plane.getCycle(cycleId));
  });
}
