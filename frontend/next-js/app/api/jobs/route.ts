import type { NextRequest } from "next/server";
import { withControlPlane } from "@/lib/api";

/** 定期実行のジョブ一覧（承認済み main の定義 + 次回の起動予定 + 直近の実行） */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) => Response.json({ jobs: await plane.listJobs() }));
}
