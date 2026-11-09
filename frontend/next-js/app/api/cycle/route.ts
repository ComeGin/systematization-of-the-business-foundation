import type { NextRequest } from "next/server";
import { withControlPlane, withControlPlaneActor } from "@/lib/api";

/** 今の周（改善ループの画面と同じ内容） */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) => Response.json(await plane.getCycle()));
}

/** 「この周を始める」。今日の周を手動で開く（既に開いていれば何もしない）。操作した人はセッションのメール */
export async function POST(request: NextRequest) {
  return withControlPlaneActor(request, async (plane, actor) => Response.json(await plane.startCycle(actor)));
}
