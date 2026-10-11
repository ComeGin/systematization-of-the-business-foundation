import type { NextRequest } from "next/server";
import { withControlPlane } from "@/lib/api";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 実行 1 件（E-15） */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/runs/[runId]">) {
  const { runId } = await ctx.params;
  return withControlPlane(request, async (plane) => {
    if (!ULID.test(runId)) return Response.json({ error: "invalid run id" }, { status: 400 });
    const run = await plane.getRun(runId);
    return run ? Response.json({ run }) : Response.json({ error: "not found" }, { status: 404 });
  });
}
