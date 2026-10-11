import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, RunRecord } from "control-plane";
import { createFakePlane, makeRun, SAMPLE_RUN_ID, type FakePlane } from "../../../helpers/control-plane";
import { asElement } from "../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };
type ListProps = { runs: RunRecord[]; hasOlder: boolean; outcome: string | null; before: string | null; pageSize: number };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  RunsListView: function RunsListView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/runs/RunsListView", () => ({ RunsListView: mocks.RunsListView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import RunsPage from "@/app/(console)/runs/page";

let plane: FakePlane;

async function render(searchParams: Record<string, string | string[] | undefined> = {}) {
  return asElement<ListProps>(await RunsPage({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) }));
}

const runs = (count: number) => Array.from({ length: count }, (_, i) => makeRun({ summary: `run ${i}` }));

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/runs（実行記録の一覧のページ）", () => {
  describe("正常系", () => {
    it("空入力: 条件が無ければ 51 件（1 ページ + 1）を読み、絞り込みなしで一覧を出す", async () => {
      plane.listRuns.mockResolvedValue(runs(3));
      const element = await render();
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 51, outcome: undefined, before: undefined });
      expect(element.type).toBe(mocks.RunsListView);
      expect(element.props).toMatchObject({ hasOlder: false, outcome: null, before: null, pageSize: 50 });
      expect(element.props.runs).toHaveLength(3);
    });

    it("空入力: 記録が 0 件なら空の一覧を出し、古いページは無いとする", async () => {
      const element = await render();
      expect(element.props.runs).toEqual([]);
      expect(element.props.hasOlder).toBe(false);
    });

    it("ちょうど 50 件なら、さらに古いページは無いとする", async () => {
      plane.listRuns.mockResolvedValue(runs(50));
      const element = await render();
      expect(element.props.runs).toHaveLength(50);
      expect(element.props.hasOlder).toBe(false);
    });

    it("51 件読めたら 50 件だけ出し、さらに古いページがあるとする", async () => {
      const rows = runs(51);
      plane.listRuns.mockResolvedValue(rows);
      const element = await render();
      expect(element.props.runs).toEqual(rows.slice(0, 50));
      expect(element.props.hasOlder).toBe(true);
    });

    it("正しい outcome と before はそのまま control-plane と画面に渡す", async () => {
      const element = await render({ outcome: "failure", before: SAMPLE_RUN_ID });
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 51, outcome: "failure", before: SAMPLE_RUN_ID });
      expect(element.props).toMatchObject({ outcome: "failure", before: SAMPLE_RUN_ID });
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）一覧を読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.listRuns).not.toHaveBeenCalled();
      expect(mocks.getControlPlaneState).not.toHaveBeenCalled();
    });

    it.each([
      ["outcome が想定外", { outcome: "running" }],
      ["outcome を 2 回指定（配列）", { outcome: ["success", "failure"] }],
      ["before が ULID でない", { before: "not-a-ulid" }],
      ["before が小文字", { before: SAMPLE_RUN_ID.toLowerCase() }],
      ["before を 2 回指定（配列）", { before: [SAMPLE_RUN_ID, SAMPLE_RUN_ID] }],
    ])("入力: %s なら、その条件を無視して一覧を出す（エラーにしない）", async (_label, searchParams) => {
      const element = await render(searchParams);
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 51, outcome: undefined, before: undefined });
      expect(element.props).toMatchObject({ outcome: null, before: null });
    });

    it("空入力: outcome と before が空文字なら、条件なしとして扱う", async () => {
      const element = await render({ outcome: "", before: "" });
      expect(plane.listRuns).toHaveBeenCalledWith({ limit: 51, outcome: undefined, before: undefined });
      expect(element.props).toMatchObject({ outcome: null, before: null });
    });

    it("サーバ: control-plane が使えなければ、原因（変数名と理由だけ）の画面を出し、一覧を読まない", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
      const element = await render();
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "CONTROL_WORKTREE: 必須" });
    });

    it("サーバ: E-15 の読み出しの例外は握りつぶさない（Next.js のエラー画面に任せる）", async () => {
      plane.listRuns.mockRejectedValue(new Error("SQLITE_BUSY"));
      await expect(render()).rejects.toThrow("SQLITE_BUSY");
    });
  });
});
