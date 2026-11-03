import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, SetupStatusView } from "control-plane";
import { createFakePlane, type FakePlane } from "../../../helpers/control-plane";
import { asElement } from "../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  SetupStatusView: function SetupStatusView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/setup-status/SetupStatusView", () => ({ SetupStatusView: mocks.SetupStatusView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import SetupStatusPage from "@/app/(console)/setup-status/page";

let plane: FakePlane;
const render = async (step?: string | string[]) =>
  asElement<{ view: SetupStatusView; selectedStepId: string | null }>(
    await SetupStatusPage({ searchParams: Promise.resolve(step === undefined ? {} : { step }) } as never),
  );

const VIEW: SetupStatusView = {
  enabled: true,
  reason: null,
  checkedAt: "2026-11-03T09:00:00+09:00",
  nextCheckAt: null,
  running: false,
  counts: { ok: 1, action: 1, warn: 0, manual: 0, unknown: 0 },
  notifyError: null,
  steps: [
    { id: "P1", title: "env", level: "ok", items: [] },
    { id: "P12", title: "ビルドと配信", level: "action", items: [] },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/setup-status（設定の状況のページ）", () => {
  describe("正常系", () => {
    it("control-plane の状況をそのまま画面に渡し、?step= が実在すればそれを選ぶ", async () => {
      plane.getSetupStatus.mockResolvedValue(VIEW);
      const element = await render("P1");
      expect(element.type).toBe(mocks.SetupStatusView);
      expect(element.props.view).toBe(VIEW);
      expect(element.props.selectedStepId).toBe("P1");
    });

    it("空入力: ?step= が無ければ、更新が必要な最初の段階を選ぶ", async () => {
      plane.getSetupStatus.mockResolvedValue(VIEW);
      expect((await render()).props.selectedStepId).toBe("P12");
    });

    it("入力: 実在しない ?step= は既定の選択に戻す", async () => {
      plane.getSetupStatus.mockResolvedValue(VIEW);
      expect((await render("P99")).props.selectedStepId).toBe("P12");
    });

    it("空入力: 無効（steps が空）のときは選択なしで渡す", async () => {
      const element = await render("P1");
      expect(element.props.view.enabled).toBe(false);
      expect(element.props.selectedStepId).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）状況を読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.getSetupStatus).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ原因の画面を出す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_WORKTREE: 必須" });
      const element = await render();
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "CONTROL_WORKTREE: 必須" });
    });

    it("サーバ: 状況の読み込みの例外は握りつぶさない", async () => {
      plane.getSetupStatus.mockRejectedValue(new Error("disk"));
      await expect(render()).rejects.toThrow("disk");
    });
  });
});
