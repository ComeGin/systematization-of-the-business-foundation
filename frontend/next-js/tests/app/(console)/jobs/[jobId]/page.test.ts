import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, JobStatus, RunRecord } from "control-plane";
import { createFakePlane, makeRun, type FakePlane } from "../../../../helpers/control-plane";
import { asElement, NEXT_NOT_FOUND } from "../../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };
type DetailProps = { job: JobStatus; runs: RunRecord[]; runLimit: number };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  JobDetailView: function JobDetailView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/jobs/JobDetailView", () => ({ JobDetailView: mocks.JobDetailView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import JobPage from "@/app/(console)/jobs/[jobId]/page";

let plane: FakePlane;

function job(id: string): JobStatus {
  return {
    definition: {
      id,
      description: `${id} の説明`,
      enabled: true,
      cron: "0 9 * * *",
      kind: "builtin",
      agent: null,
      builtin: "heartbeat",
      after: [],
      timeoutSec: 60,
      maxTurns: null,
    },
    nextRunAt: null,
    lastRun: null,
  };
}

async function render(jobId: string) {
  return asElement<DetailProps>(await JobPage({ params: Promise.resolve({ jobId }), searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/jobs/[jobId]（ジョブの詳細のページ）", () => {
  describe("正常系", () => {
    it("一覧から定義を探し、そのジョブの実行記録を 50 件まで読んで出す", async () => {
      const target = job("daily-seo");
      const runs = [makeRun()];
      plane.listJobs.mockResolvedValue([job("heartbeat"), target]);
      plane.listRuns.mockResolvedValue(runs);
      const element = await render("daily-seo");
      expect(plane.listRuns).toHaveBeenCalledWith({ jobId: "daily-seo", limit: 50 });
      expect(element.type).toBe(mocks.JobDetailView);
      expect(element.props).toEqual({ job: target, runs, runLimit: 50 });
    });

    it("空入力: 実行記録が 0 件でも詳細を出す", async () => {
      plane.listJobs.mockResolvedValue([job("daily-seo")]);
      const element = await render("daily-seo");
      expect(element.props.runs).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）何も読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render("daily-seo")).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.listJobs).not.toHaveBeenCalled();
    });

    it.each([
      ["定義に無い id", "nope"],
      ["大文字小文字が違う", "DAILY-SEO"],
      ["SQL などの任意の文字列", "' OR 1=1 --"],
    ])("入力: %s なら 404 にし、実行記録の検索に渡さない", async (_label, jobId) => {
      plane.listJobs.mockResolvedValue([job("daily-seo")]);
      await expect(render(jobId)).rejects.toThrow(NEXT_NOT_FOUND);
      expect(plane.listRuns).not.toHaveBeenCalled();
    });

    it("空入力: ジョブが 0 件なら 404 にする", async () => {
      await expect(render("daily-seo")).rejects.toThrow(NEXT_NOT_FOUND);
      expect(plane.listRuns).not.toHaveBeenCalled();
    });

    it("空入力: id が空文字なら 404 にする", async () => {
      plane.listJobs.mockResolvedValue([job("daily-seo")]);
      await expect(render("")).rejects.toThrow(NEXT_NOT_FOUND);
    });

    it("サーバ: control-plane が使えなければ原因の画面を出し、定義を読まない", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_MAIN_CHECKOUT: 必須" });
      const element = await render("daily-seo");
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "CONTROL_MAIN_CHECKOUT: 必須" });
      expect(plane.listJobs).not.toHaveBeenCalled();
    });

    it("サーバ: 定義の読み込みの例外（YAML の誤りなど）は握りつぶさない", async () => {
      plane.listJobs.mockRejectedValue(new Error("YAML parse error"));
      await expect(render("daily-seo")).rejects.toThrow("YAML parse error");
    });

    it("サーバ: 実行記録の読み出しの例外は握りつぶさない", async () => {
      plane.listJobs.mockResolvedValue([job("daily-seo")]);
      plane.listRuns.mockRejectedValue(new Error("SQLITE_BUSY"));
      await expect(render("daily-seo")).rejects.toThrow("SQLITE_BUSY");
    });
  });
});
