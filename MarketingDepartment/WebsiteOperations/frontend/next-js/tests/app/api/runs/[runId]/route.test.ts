import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane } from "control-plane";
import { createFakePlane, makeRun, SAMPLE_RUN_ID, type FakePlane } from "../../../../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { GET } from "@/app/api/runs/[runId]/route";

let plane: FakePlane;

function get(runId: string) {
  const ctx: RouteContext<"/api/runs/[runId]"> = { params: Promise.resolve({ runId }) };
  return GET(new NextRequest(`http://127.0.0.1:3200/api/runs/${encodeURIComponent(runId)}`), ctx);
}

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("GET /api/runs/[runId]", () => {
  it("未ログインなら、ID の検証より先に 401 を返す", async () => {
    mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await get("not-a-ulid");
    expect(res.status).toBe(401);
    expect(plane.getRun).not.toHaveBeenCalled();
  });

  it("見つかれば { run } を返す", async () => {
    const run = makeRun();
    plane.getRun.mockResolvedValue(run);
    const res = await get(SAMPLE_RUN_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run });
    expect(plane.getRun).toHaveBeenCalledWith(SAMPLE_RUN_ID);
  });

  it("見つからなければ 404 を返す", async () => {
    const res = await get(SAMPLE_RUN_ID);
    expect(res.status).toBe(404);
  });

  it.each([
    ["小文字", SAMPLE_RUN_ID.toLowerCase()],
    ["25 文字", SAMPLE_RUN_ID.slice(1)],
    ["27 文字", `${SAMPLE_RUN_ID}0`],
    ["Crockford で使わない文字（I・L・O・U）を含む", `${SAMPLE_RUN_ID.slice(0, 22)}ILOU`],
    ["パスの区切りを含む", `../${SAMPLE_RUN_ID.slice(3)}`],
  ])("ID が ULID でない（%s）なら 400 を返し、control-plane に問い合わせない", async (_label, runId) => {
    const res = await get(runId);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid run id" });
    expect(plane.getRun).not.toHaveBeenCalled();
  });
});
