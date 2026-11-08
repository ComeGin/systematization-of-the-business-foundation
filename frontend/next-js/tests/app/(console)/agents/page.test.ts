import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentListing, ControlPlane } from "control-plane";
import { createFakePlane, makeAgent, type FakePlane } from "../../../helpers/control-plane";
import { asElement } from "../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  AgentsListView: function AgentsListView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/agents/AgentsListView", () => ({ AgentsListView: mocks.AgentsListView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import AgentsPage from "@/app/(console)/agents/page";

let plane: FakePlane;
const render = async () => asElement<{ listing: AgentListing }>(await AgentsPage());

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/agents（Agent の一覧のページ）", () => {
  describe("正常系", () => {
    it("listAgents の結果（名前の順の Agent と読めない定義）をそのまま一覧に渡す", async () => {
      const listing = { agents: [makeAgent({ name: "analytics-reporter" }), makeAgent()], errors: [{ file: "x.md", reason: "frontmatter が無い: x" }] };
      plane.listAgents.mockResolvedValue(listing);
      const element = await render();
      expect(element.type).toBe(mocks.AgentsListView);
      expect(element.props.listing).toBe(listing);
    });

    it("空入力: Agent が 0 本なら空の一覧を渡す", async () => {
      plane.listAgents.mockResolvedValue({ agents: [], errors: [] });
      expect((await render()).props.listing).toEqual({ agents: [], errors: [] });
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら一覧を読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.listAgents).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ、原因の画面を出す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_MAIN_CHECKOUT: 必須" });
      const element = await render();
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "CONTROL_MAIN_CHECKOUT: 必須" });
    });
  });
});
