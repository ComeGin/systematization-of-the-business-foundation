import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, JobStatus } from "control-plane";
import { createFakePlane, type FakePlane } from "../../../../helpers/control-plane";
import { asElement } from "../../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };
type CreateProps = { jobs: { id: string; description: string }[]; initialJobId: string | null };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  RunCreateView: function RunCreateView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/runs/RunCreateView", () => ({ RunCreateView: mocks.RunCreateView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import RunCreatePage from "@/app/(console)/runs/new/page";

let plane: FakePlane;

function job(id: string, description: string): JobStatus {
  return {
    definition: {
      id,
      description,
      enabled: true,
      cron: "0 9 * * *",
      kind: "agent",
      agent: "seo-auditor",
      builtin: null,
      after: [],
      timeoutSec: 600,
      maxTurns: 30,
    },
    nextRunAt: null,
    lastRun: null,
  };
}

async function render(searchParams: Record<string, string | string[] | undefined> = {}) {
  return asElement<CreateProps>(await RunCreatePage({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/runs/new（手動の起動のページ）", () => {
  describe("正常系", () => {
    it("定義の id と説明だけをフォームに渡し、?jobId= があればその定義を選んだ状態で開く", async () => {
      plane.listJobs.mockResolvedValue([job("daily-seo", "SEO の観測"), job("weekly-report", "週報")]);
      const element = await render({ jobId: "daily-seo" });
      expect(element.type).toBe(mocks.RunCreateView);
      expect(element.props).toEqual({
        jobs: [
          { id: "daily-seo", description: "SEO の観測" },
          { id: "weekly-report", description: "週報" },
        ],
        initialJobId: "daily-seo",
      });
    });

    it("空入力: ?jobId= が無ければ何も選ばない", async () => {
      const element = await render();
      expect(element.props.initialJobId).toBeNull();
    });

    it("空入力: ジョブが 0 件でもフォームを出す（エージェントの指示だけ使える）", async () => {
      const element = await render();
      expect(element.props.jobs).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）定義を読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.listJobs).not.toHaveBeenCalled();
    });

    it("入力: ?jobId= を 2 回指定（配列）したら何も選ばない", async () => {
      const element = await render({ jobId: ["a", "b"] });
      expect(element.props.initialJobId).toBeNull();
    });

    it("サーバ: control-plane が使えなければ原因の画面を出し、定義を読まない", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
      const element = await render();
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(plane.listJobs).not.toHaveBeenCalled();
    });

    it("サーバ: 定義の読み込みの例外は握りつぶさない", async () => {
      plane.listJobs.mockRejectedValue(new Error("ENOENT ops/schedules"));
      await expect(render()).rejects.toThrow("ENOENT");
    });
  });
});
