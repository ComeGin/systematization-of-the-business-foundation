import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, JobStatus, RunObservations } from "control-plane";
import { createFakePlane, type FakePlane, makeJob, makeObservations, makeRun, SAMPLE_RUN_ID } from "../../../helpers/control-plane";
import { asElement } from "../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  JobsListView: function JobsListView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/jobs/JobsListView", () => ({ JobsListView: mocks.JobsListView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import JobsPage from "@/app/(console)/jobs/page";

let plane: FakePlane;
const render = async () => asElement<{ jobs: JobStatus[]; observations: Record<string, RunObservations> }>(await JobsPage());

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/jobs（ジョブの一覧のページ）", () => {
  describe("正常系", () => {
    it("control-plane のジョブ一覧をそのまま一覧の画面に渡す", async () => {
      const jobs = [{ definition: { id: "daily-seo" }, nextRunAt: null, lastRun: null }] as unknown as JobStatus[];
      plane.listJobs.mockResolvedValue(jobs);
      const element = await render();
      expect(element.type).toBe(mocks.JobsListView);
      expect(element.props.jobs).toBe(jobs);
    });

    it("直近の実行の runId で listRunObservations を 1 回呼び、runId ごとの観測を渡す", async () => {
      const withRun = makeJob("daily-seo", "seo-auditor");
      withRun.lastRun = makeRun();
      plane.listJobs.mockResolvedValue([withRun, makeJob("heartbeat", null)]);
      const observed = makeObservations();
      plane.listRunObservations.mockResolvedValue([observed]);
      const element = await render();
      expect(plane.listRunObservations).toHaveBeenCalledTimes(1);
      expect(plane.listRunObservations).toHaveBeenCalledWith([SAMPLE_RUN_ID]);
      expect(element.props.observations).toEqual({ [SAMPLE_RUN_ID]: observed });
    });

    it("空入力: 直近の実行がどれにも無ければ観測を読まない", async () => {
      plane.listJobs.mockResolvedValue([makeJob("heartbeat", null)]);
      const element = await render();
      expect(plane.listRunObservations).not.toHaveBeenCalled();
      expect(element.props.observations).toEqual({});
    });

    it("空入力: ジョブが 0 件なら空の一覧を渡す", async () => {
      expect((await render()).props.jobs).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）定義を読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.listJobs).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ原因の画面を出す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
      const element = await render();
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "CONTROL_WORKTREE: 必須" });
    });

    it("サーバ: 定義の読み込みの例外は握りつぶさない", async () => {
      plane.listJobs.mockRejectedValue(new Error("YAML parse error"));
      await expect(render()).rejects.toThrow("YAML parse error");
    });
  });
});
