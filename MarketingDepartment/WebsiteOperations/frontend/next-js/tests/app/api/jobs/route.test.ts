import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, JobStatus } from "control-plane";
import { createFakePlane, type FakePlane } from "../../../helpers/control-plane";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  guardApiRequest: vi.fn(async (_request: Request): Promise<Response | null> => null),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
}));

vi.mock("@/lib/session", () => ({ guardApiRequest: mocks.guardApiRequest }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));

import { GET } from "@/app/api/jobs/route";

let plane: FakePlane;
const get = () => GET(new NextRequest("http://127.0.0.1:3200/api/jobs"));

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("GET /api/jobs", () => {
  it("未ログインなら 401 を返し、ジョブを読まない", async () => {
    mocks.guardApiRequest.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await get();
    expect(res.status).toBe(401);
    expect(plane.listJobs).not.toHaveBeenCalled();
  });

  it("ジョブ一覧を { jobs } で返す", async () => {
    const jobs: JobStatus[] = [
      {
        definition: {
          id: "daily-seo",
          description: "SEO の観測",
          enabled: true,
          cron: "0 9 * * *",
          kind: "agent",
          agent: "seo-auditor",
          builtin: null,
          after: [],
          timeoutSec: 600,
          maxTurns: 30,
        },
        nextRunAt: "2026-10-06T09:00:00+09:00",
        lastRun: null,
      },
    ];
    plane.listJobs.mockResolvedValue(jobs);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs });
  });

  it("control-plane が使えなければ 503 を返す", async () => {
    mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
    const res = await get();
    expect(res.status).toBe(503);
  });

  it("定義の読み込みで例外が起きたら 500 を返し、詳細を出さない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    plane.listJobs.mockRejectedValue(new Error("YAML parse error at /main/ops/schedules/x.yaml"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});
