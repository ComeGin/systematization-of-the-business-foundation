import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, MiswriteCandidate } from "control-plane";
import { createFakePlane, SAMPLE_RUN_ID, type FakePlane } from "../../../helpers/control-plane";
import { asElement } from "../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  CandidatesListView: function CandidatesListView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/miswrite-candidates/CandidatesListView", () => ({ CandidatesListView: mocks.CandidatesListView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import MiswriteCandidatesPage from "@/app/(console)/miswrite-candidates/page";

let plane: FakePlane;
const render = async () => asElement<{ candidates: MiswriteCandidate[] }>(await MiswriteCandidatesPage());

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/miswrite-candidates（誤った書き込みの候補のページ）", () => {
  describe("正常系", () => {
    it("control-plane の候補をそのまま一覧の画面に渡す", async () => {
      const candidates: MiswriteCandidate[] = [
        { conversationDisplayId: 12, messageId: 345, sentAt: "2026-10-05T10:00:00+09:00", nearestRunId: SAMPLE_RUN_ID, reason: "x" },
      ];
      plane.listMiswriteCandidates.mockResolvedValue(candidates);
      const element = await render();
      expect(element.type).toBe(mocks.CandidatesListView);
      expect(element.props.candidates).toBe(candidates);
    });

    it("空入力: 候補が 0 件なら空の一覧を渡す", async () => {
      expect((await render()).props.candidates).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）候補を読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
    });

    it("サーバ: control-plane が使えなければ原因の画面を出す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "MISWRITE_AGENT_USER_ID: 必須" });
      const element = await render();
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "MISWRITE_AGENT_USER_ID: 必須" });
    });

    it("サーバ: 候補の照会（Chatwoot）の例外は握りつぶさない", async () => {
      plane.listMiswriteCandidates.mockRejectedValue(new Error("Chatwoot 429"));
      await expect(render()).rejects.toThrow("Chatwoot 429");
    });
  });
});
