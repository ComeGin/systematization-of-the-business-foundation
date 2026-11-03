import type { NextRequest } from "next/server";
import { withControlPlane } from "@/lib/api";

/** 設定の状況（直近の確認結果）。無効のときは enabled=false で steps は空 */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) => Response.json(await plane.getSetupStatus()));
}

/** 「今すぐ確かめる」。完了を待たずに返す。確認中だったときは accepted=false（Origin の確認は withControlPlane のガード） */
export async function POST(request: NextRequest) {
  return withControlPlane(request, async (plane) => {
    const result = await plane.refreshSetupStatus();
    return Response.json(result, { status: result.accepted ? 202 : 200 });
  });
}
