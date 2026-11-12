import type { NextRequest } from "next/server";
import * as z from "zod";
import { withControlPlane, withControlPlaneActor } from "@/lib/api";

const AGENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MODEL = z.string().min(1).max(128).nullable();

// 実行モデルの選択。actor は本文に含めない（セッションから決める）。model が null なら選択を外す（定義・環境変数の値に戻す）。
// モデル名が各社の一覧に無い・一覧を読めない・エージェントの定義が無いときは、control-plane が ControlPlaneInputError（400）にする
const SetModelBody = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("anthropic"), agent: z.string().regex(AGENT_NAME).nullable(), model: MODEL }),
  z.object({ provider: z.literal("openai"), use: z.literal("image"), model: MODEL }),
]);

/** 実行モデルの選択と、選べる一覧（各社の API から。control-plane が 10 分覚える） */
export async function GET(request: NextRequest) {
  return withControlPlane(request, async (plane) => Response.json(await plane.getModelSettings()));
}

/** 実行モデルを選ぶ。更新後の画面の値を返す */
export async function POST(request: NextRequest) {
  return withControlPlaneActor(request, async (plane, actor) => {
    const body = SetModelBody.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "invalid body" }, { status: 400 });
    const { model, ...rest } = body.data;
    const target = rest.provider === "anthropic" ? { provider: "anthropic" as const, agent: rest.agent } : { provider: "openai" as const, use: "image" as const };
    return Response.json(await plane.setModelSetting(target, model, actor));
  });
}
