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
  describe("正常系", () => {
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

    it("空入力: 候補が 0 件なら { candidates: [] } を返す", async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ candidates: [] });
    });
  });

  describe("異常系", () => {
    it("入力: 未ログイン・許可リスト外（どちらもセッションが無く、ガードが 401）なら 401 を返し、候補を読まない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
      const res = await get();
      expect(res.status).toBe(401);
      expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
    });

    it("サーバ: ログインの仕組みが使えない（ガードが 503）なら、その応答を返し、候補を読まない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "authentication is unavailable" }, { status: 503 }));
      const res = await get();
      expect(res.status).toBe(503);
      expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ 503 を返す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "MISWRITE_AGENT_USER_ID: 必須" });
      const res = await get();
      expect(res.status).toBe(503);
      expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
    });

    it("サーバ: Chatwoot の照会などで例外が起きたら 500 を返し、詳細（上流の応答）を出さない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      plane.listMiswriteCandidates.mockRejectedValue(new Error("Chatwoot 401: api_access_token=abc123 is invalid"));
      const res = await get();
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ error: "internal error" });
      expect(body).not.toContain("abc123");
    });
  });
});
