import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, MiswriteCandidate } from "control-plane";
import { createFakePlane, SAMPLE_RUN_ID, type FakePlane } from "../../../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { GET } from "@/app/api/miswrite-candidates/route";

let plane: FakePlane;
const get = () => GET(new NextRequest("http://127.0.0.1:3200/api/miswrite-candidates"));

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("GET /api/miswrite-candidates", () => {
  it("未ログインなら 401 を返し、候補を読まない", async () => {
    mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await get();
    expect(res.status).toBe(401);
    expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
  });

  it("誤った書き込みの候補を { candidates } で返す", async () => {
    const candidates: MiswriteCandidate[] = [
      {
        conversationDisplayId: 12,
        messageId: 345,
        sentAt: "2026-10-05T10:00:00+09:00",
        nearestRunId: SAMPLE_RUN_ID,
        reason: "no matching proposal",
      },
    ];
    plane.listMiswriteCandidates.mockResolvedValue(candidates);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates });
  });

  it("control-plane が使えなければ 503 を返す", async () => {
    mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "MISWRITE_AGENT_USER_ID: 必須" });
    const res = await get();
    expect(res.status).toBe(503);
    expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
  });
});
