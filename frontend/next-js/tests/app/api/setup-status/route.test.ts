import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, SetupStatusView } from "control-plane";
import { createFakePlane, sameOriginInit, type FakePlane } from "../../../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { GET, POST } from "@/app/api/setup-status/route";

let plane: FakePlane;
const URL_ = "http://127.0.0.1:3200/api/setup-status";
const get = () => GET(new NextRequest(URL_));
const post = () => POST(new NextRequest(URL_, sameOriginInit({})));

const VIEW: SetupStatusView = {
  enabled: true,
  reason: null,
  checkedAt: "2026-11-03T09:00:00+09:00",
  nextCheckAt: "2026-11-03T10:00:00+09:00",
  running: false,
  counts: { ok: 1, action: 1, warn: 0, manual: 0, unknown: 0 },
  notifyError: null,
  steps: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("GET /api/setup-status", () => {
  describe("正常系", () => {
    it("設定の状況をそのまま返す", async () => {
      plane.getSetupStatus.mockResolvedValue(VIEW);
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(VIEW);
    });

    it("空入力: 無効（enabled=false）のときも 200 で理由を返す", async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ enabled: false, steps: [] });
    });
  });

  describe("異常系", () => {
    it("入力: 未ログイン（ガードが 401）なら 401 を返し、状況を読まない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
      const res = await get();
      expect(res.status).toBe(401);
      expect(plane.getSetupStatus).not.toHaveBeenCalled();
      expect(mocks.getControlPlaneState).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ 503 を返す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
      const res = await get();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "CONTROL_WORKTREE: 必須" });
    });

    it("サーバ: 読み込みで例外が起きたら 500 を返し、詳細を出さない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      plane.getSetupStatus.mockRejectedValue(new Error("ENOENT /secret/path"));
      const res = await get();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
    });
  });
});

describe("POST /api/setup-status", () => {
  describe("正常系", () => {
    it("確認を始めたら 202 と { accepted: true } を返す", async () => {
      plane.refreshSetupStatus.mockResolvedValue({ accepted: true });
      const res = await post();
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true });
    });

    it("確認中で受け付けなかったときは 200 と { accepted: false } を返す", async () => {
      plane.refreshSetupStatus.mockResolvedValue({ accepted: false });
      const res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted: false });
    });

    it("状態を変える要求なので、ガードには Request をそのまま渡す（Origin の確認はガードの役目）", async () => {
      await post();
      expect(mocks.guardApiRequest).toHaveBeenCalledTimes(1);
      expect(mocks.guardApiRequest.mock.calls[0]![0].method).toBe("POST");
    });
  });

  describe("異常系", () => {
    it("入力: ガードが 403（別のオリジン）なら 403 を返し、確認を始めない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "cross-origin request" }, { status: 403 }));
      const res = await post();
      expect(res.status).toBe(403);
      expect(plane.refreshSetupStatus).not.toHaveBeenCalled();
    });

    it("入力: 未ログイン（ガードが 401）なら 401 を返し、確認を始めない", async () => {
      mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
      const res = await post();
      expect(res.status).toBe(401);
      expect(plane.refreshSetupStatus).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ 503 を返す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "未設定" });
      expect((await post()).status).toBe(503);
    });

    it("サーバ: 例外が起きたら 500 を返し、詳細を出さない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      plane.refreshSetupStatus.mockRejectedValue(new Error("boom"));
      const res = await post();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
    });
  });
});
