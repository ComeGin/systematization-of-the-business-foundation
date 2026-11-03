import type { NextRequest } from "next/server";
import * as z from "zod";
import { withControlPlane } from "@/lib/api";

// 許可リスト（カタログの docs に現れるもの）の判定は control-plane が行う。ここでは形だけ確かめる
const DocQuery = z.object({
  file: z.string().min(1).max(300),
  heading: z.string().min(1).max(200),
});

/** 手順書（承認済み main のチェックアウト）の 1 節。許可されないファイル・見つからない見出しは 404 */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) => {
    const parsed = DocQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) return Response.json({ error: "invalid query" }, { status: 400 });
    const section = await plane.readSetupDoc(parsed.data.file, parsed.data.heading);
    if (!section) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(section);
  });
}
