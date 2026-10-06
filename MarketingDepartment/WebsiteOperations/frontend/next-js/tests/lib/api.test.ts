import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane } from "control-plane";
import { createFakePlane } from "../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { withControlPlane } from "@/lib/api";

const request = () => new Request("http://127.0.0.1:3200/api/runs?jobId=secret-job", { method: "GET" });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("withControlPlane", () => {
  it("ガードが拒否したら、その応答をそのまま返し、control-plane に触れない", async () => {
    const denied = Response.json({ error: "unauthorized" }, { status: 401 });
    mocks.guardApiRequest.mockResolvedValue(denied);
    const handler = vi.fn(async () => new Response("ok"));
    await expect(withControlPlane(request(), handler)).resolves.toBe(denied);
    expect(mocks.getControlPlaneState).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("control-plane の初期化に失敗しているなら 503 と原因（変数名と理由だけ）を返す", async () => {
    mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
    const handler = vi.fn(async () => new Response("ok"));
    const res = await withControlPlane(request(), handler);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "CONTROL_WORKTREE: 必須" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("許可されたら control-plane を渡して処理し、その応答を返す", async () => {
    const plane = createFakePlane();
    mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
    const res = await withControlPlane(request(), async (p) => {
      expect(p).toBe(plane);
      return Response.json({ ok: true }, { status: 202 });
    });
    expect(res.status).toBe(202);
  });

  it("ControlPlaneInputError は（instanceof でなく）name で判定して 400 とメッセージを返す", async () => {
    mocks.getControlPlaneState.mockReturnValue({ plane: createFakePlane(), error: null });
    const error = new Error("定期実行の定義が見つからない: x");
    error.name = "ControlPlaneInputError";
    const res = await withControlPlane(request(), async () => {
      throw error;
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "定期実行の定義が見つからない: x" });
  });

  it("それ以外の例外は 500 にし、詳細を応答に出さない。ログにはパスだけを残す（クエリは残さない）", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getControlPlaneState.mockReturnValue({ plane: createFakePlane(), error: null });
    const res = await withControlPlane(request(), async () => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    const logged = consoleError.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("GET /api/runs");
    expect(logged).not.toContain("secret-job");
  });

  it("Error でない値が投げられても 500 を返す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getControlPlaneState.mockReturnValue({ plane: createFakePlane(), error: null });
    const res = await withControlPlane(request(), async () => {
      throw "boom";
    });
    expect(res.status).toBe(500);
  });
});
