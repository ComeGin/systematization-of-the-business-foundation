import type { NextRequest } from "next/server";
import { withControlPlane } from "@/lib/api";

/** 誤った書き込みの候補（エージェント専用ユーザーの送信のうち、どの E-13 にも E-15 にも対応しないもの） */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) =>
    Response.json({ candidates: await plane.listMiswriteCandidates() }),
  );
}
