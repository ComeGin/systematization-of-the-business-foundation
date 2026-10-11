import type { NextRequest } from "next/server";
import * as z from "zod";
import { withControlPlane } from "@/lib/api";

const AGENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().regex(ULID).optional(),
  jobId: z.string().min(1).max(100).optional(),
  outcome: z.enum(["success", "failure", "partial", "skipped"]).optional(),
});

// 手動の指示。エージェント名とプロンプト、または定期実行の定義の id
const ManualRunBody = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), agent: z.string().regex(AGENT_NAME), prompt: z.string().min(1).max(20_000) }),
    z.object({ kind: z.literal("job"), jobId: z.string().min(1).max(100) }),
  ]),
});

/** 実行の一覧（E-15） */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) => {
    const parsed = ListQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return Response.json({ error: "invalid query" }, { status: 400 });
    return Response.json({ runs: await plane.listRuns(parsed.data) });
  });
}

/** 手動の起動。完了を待たずに返す。前回が実行中などで見送ったときは accepted=false（skipped が記録される） */
export async function POST(request: NextRequest) {
  return withControlPlane(request, async (plane) => {
    const body = ManualRunBody.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid body" }, { status: 400 });
    const result = await plane.runNow(body.data);
    return Response.json(result, { status: result.accepted ? 202 : 200 });
  });
}
