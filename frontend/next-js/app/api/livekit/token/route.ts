import { randomUUID } from "node:crypto";
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import type { NextRequest } from "next/server";
import * as z from "zod";
import { readLiveKitServerConfig } from "@/lib/livekit/server-config";
import { getSession, guardApiRequest } from "@/lib/session";

// 音声 BI（/voice）の LiveKit のトークンを発行する（I-34）。LiveKit の標準のトークンの API の形
// （https://docs.livekit.io/frontends/build/authentication/endpoint/）に合わせ、TokenSource.endpoint から呼ぶ。
//  - 要求: POST の JSON（項目名は snake_case）。応答: 201 で { server_url, participant_token }
//  - だれが・どの部屋に入るかはサーバーが決める。identity はセッションのメール、ルーム名は voice-<uuid>。
//    クライアントが participant_identity・room_name・participant_name を送ってきたら 400 にする
//  - dispatch するエージェントは LIVEKIT_AGENT_NAME だけ。room_config で別の名前を頼まれたら 400 にする
//  - 権限は roomJoin・canPublish・canSubscribe・canPublishData だけ。TTL は 10 分（接続の時点で有効なら、接続後は切れない）
//  - 本文は 8 KB まで（超えれば 413）
// SFU が止まっていても発行はできる（接続の段で失敗する）。その案内は画面（components/voice）が出す。

const TOKEN_TTL = "10m";

/** クライアントに決めさせない項目。送られてきたら 400 */
const FORBIDDEN_FIELDS = ["participant_identity", "room_name", "participant_name"] as const;

const AgentDispatchBody = z
  .object({
    agent_name: z.string().min(1).max(128),
  })
  .strict();

// room_config はエージェントの dispatch（1 体）だけを受ける。ほかの項目（部屋の寿命・egress など）は受けない
const TokenRequestBody = z
  .object({
    room_config: z.object({ agents: z.array(AgentDispatchBody).length(1) }).strict(),
    // 送られても使わない（空なら許す）。中身があれば 400
    participant_metadata: z.literal("").optional(),
    participant_attributes: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length === 0).optional(),
  })
  .strict();

/** 本文の上限（8 KB） */
const MAX_BODY_BYTES = 8 * 1024;

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function tooLarge(): Response {
  return Response.json({ error: "body is too large" }, { status: 413 });
}

/** トークンを発行する */
export async function POST(request: NextRequest) {
  const denied = await guardApiRequest(request);
  if (denied) return denied;
  // identity に使うメールを読むため、もう一度セッションを読む（guardApiRequest と同じく、読めなければ 503）
  let session;
  try {
    session = await getSession();
  } catch {
    return Response.json({ error: "authentication is unavailable" }, { status: 503 });
  }
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const settings = readLiveKitServerConfig();
  if (!settings.ok) {
    // 値は出さない（変数名だけ）
    console.error(`- ERROR api POST /api/livekit/token: LiveKit の環境変数が足りない（${settings.missing.join("・")}）`);
    return Response.json({ error: "livekit is not configured" }, { status: 500 });
  }
  const { serverUrl, apiKey, apiSecret, agentName } = settings.config;

  // 本文は小さい（room_config の dispatch だけ）。申告の長さと、実際に読んだ長さの両方で上限を見る
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();
  const text = await request.text().catch(() => null);
  if (text === null) return badRequest("invalid body");
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return badRequest("invalid body");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return badRequest("invalid body");
  const forbidden = FORBIDDEN_FIELDS.filter((key) => key in raw);
  if (forbidden.length > 0) return badRequest(`${forbidden.join(", ")} must not be set by the client`);
  const body = TokenRequestBody.safeParse(raw);
  if (!body.success) return badRequest("invalid body");
  if (body.data.room_config.agents[0].agent_name !== agentName) return badRequest("unknown agent_name");

  const roomName = `voice-${randomUUID()}`;
  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: session.user.email,
      name: session.user.name || session.user.email,
      ttl: TOKEN_TTL,
    });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    // クライアントの room_config はそのまま渡さず、検証した名前で作り直す
    token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName })] });
    const participantToken = await token.toJwt();
    return Response.json({ server_url: serverUrl, participant_token: participantToken }, { status: 201 });
  } catch (error) {
    console.error(`- ERROR api POST /api/livekit/token: ${error instanceof Error ? error.name : "不明"}`);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
