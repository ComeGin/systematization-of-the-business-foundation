import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ControlPlane, JobStatus, RunObservations, RunRecord } from "control-plane";
import { createFakePlane, makeAgent, makeJob, makeObservations, makeRun, type FakePlane } from "../../../../helpers/control-plane";
import { asElement, NEXT_NOT_FOUND } from "../../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };
type DetailProps = { agent: AgentInfo; jobs: JobStatus[]; recentRuns: RunRecord[]; observations: Record<string, RunObservations> };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  AgentDetailView: function AgentDetailView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/agents/AgentDetailView", () => ({ AgentDetailView: mocks.AgentDetailView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import AgentPage from "@/app/(console)/agents/[name]/page";

let plane: FakePlane;
const render = async (name: string) =>
  asElement<DetailProps>(await AgentPage({ params: Promise.resolve({ name }), searchParams: Promise.resolve({}) }));

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/agents/[name]（Agent の詳細のページ）", () => {
  describe("正常系", () => {
    it("Agent と、使うジョブ（jobIds の順）と、この Agent の直近の実行 5 件（ジョブごとの記録と手動の起動を合わせた新しい順）とその観測を渡す", async () => {
      const agent = makeAgent({ jobIds: ["b-job", "a-job"] });
      plane.getAgent.mockResolvedValue(agent);
      plane.listJobs.mockResolvedValue([makeJob("a-job", "seo-auditor"), makeJob("other", "lead-ops"), makeJob("b-job", "seo-auditor")]);
      const run = (suffix: string, extra: Partial<RunRecord> = {}) =>
        makeRun({ runId: `01J9ZK3M4N5P6Q7R8S9T0V1W2${suffix}`, agentName: "seo-auditor", ...extra });
      // 週次のジョブの記録は、全体の新しい 50 件に入らないことがある（2026-11-06 の最終レビュー）ので、ジョブごとに読む
      plane.listRuns.mockImplementation(async (query) => {
        if (query?.jobId === "a-job") return [run("F", { jobId: "a-job" }), run("B", { jobId: "a-job" })];
        if (query?.jobId === "b-job") return [run("E", { jobId: "b-job" }), run("A", { jobId: "b-job" })];
        return [run("G", { jobId: null }), run("Z", { agentName: "lead-ops" }), run("F", { jobId: "a-job" }), run("C", { jobId: null })];
      });
      plane.listRunObservations.mockImplementation(async (ids) => ids.map((runId) => makeObservations({ runId })));

      const element = await render("seo-auditor");
      expect(plane.getAgent).toHaveBeenCalledWith("seo-auditor");
      expect(plane.listRuns).toHaveBeenCalledWith({ jobId: "b-job", limit: 5 });
      expect(plane.listRuns).toHaveBeenCalledWith({ jobId: "a-job", limit: 5 });
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 50 });
      expect(element.type).toBe(mocks.AgentDetailView);
      expect(element.props.agent).toBe(agent);
      expect(element.props.jobs.map((job) => job.definition.id)).toEqual(["b-job", "a-job"]);
      const expected = ["G", "F", "E", "C", "B"].map((suffix) => `01J9ZK3M4N5P6Q7R8S9T0V1W2${suffix}`);
      expect(element.props.recentRuns.map((r) => r.runId)).toEqual(expected);
      expect(plane.listRunObservations).toHaveBeenCalledWith(expected);
      expect(Object.keys(element.props.observations)).toEqual(expected);
    });

    it("空入力: 使うジョブも実行も無ければ空で渡す", async () => {
      plane.getAgent.mockResolvedValue(makeAgent({ jobIds: [] }));
      const element = await render("seo-auditor");
      expect(element.props).toMatchObject({ jobs: [], recentRuns: [], observations: {} });
    });
  });

  describe("異常系", () => {
    it("入力: getAgent が null なら 404", async () => {
      plane.getAgent.mockResolvedValue(null);
      await expect(render("no-such")).rejects.toThrow(NEXT_NOT_FOUND);
    });

    it.each(["../x", "Seo-Auditor", "seo_auditor", ""])("入力: 名前 %j が AGENT_NAME_PATTERN に合わなければ getAgent を呼ばずに 404", async (name) => {
      await expect(render(name)).rejects.toThrow(NEXT_NOT_FOUND);
      expect(plane.getAgent).not.toHaveBeenCalled();
    });

    it("入力: 未ログインなら何も読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render("seo-auditor")).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.getAgent).not.toHaveBeenCalled();
    });
  });
});
