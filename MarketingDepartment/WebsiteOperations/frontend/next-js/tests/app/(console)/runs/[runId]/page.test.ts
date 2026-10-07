import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPlane, MiswriteCandidate, RunRecord } from "control-plane";
import { createFakePlane, makeRun, SAMPLE_RUN_ID, type FakePlane } from "../../../../helpers/control-plane";
import { asElement, NEXT_NOT_FOUND } from "../../../../helpers/page";

type State = { plane: ControlPlane; error: null } | { plane: null; error: string };
type DetailProps = { run: RunRecord; candidates: MiswriteCandidate[] };

const mocks = vi.hoisted(() => ({
  requirePageSession: vi.fn(async (): Promise<unknown> => ({ user: { name: "管理者" } })),
  getControlPlaneState: vi.fn((): State => ({ plane: null, error: "未設定" })),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  RunDetailView: function RunDetailView() {
    return null;
  },
  ConfigErrorView: function ConfigErrorView() {
    return null;
  },
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/session", () => ({ requirePageSession: mocks.requirePageSession }));
vi.mock("@/lib/control-plane", () => ({ getControlPlaneState: mocks.getControlPlaneState }));
vi.mock("@/components/runs/RunDetailView", () => ({ RunDetailView: mocks.RunDetailView }));
vi.mock("@/components/common/ConfigErrorView", () => ({ ConfigErrorView: mocks.ConfigErrorView }));

import RunPage from "@/app/(console)/runs/[runId]/page";

const OTHER_RUN_ID = "01J9ZK3M4N5P6Q7R8S9T0V1W2Y";
let plane: FakePlane;

async function render(runId: string) {
  return asElement<DetailProps>(await RunPage({ params: Promise.resolve({ runId }), searchParams: Promise.resolve({}) }));
}

function candidate(nearestRunId: string | null, messageId: number): MiswriteCandidate {
  return { conversationDisplayId: 1, messageId, sentAt: "2026-10-05T09:01:00+09:00", nearestRunId, reason: "no matching proposal" };
}

beforeEach(() => {
  vi.resetAllMocks();
  plane = createFakePlane();
  mocks.getControlPlaneState.mockReturnValue({ plane, error: null });
});

describe("/runs/[runId]（実行の詳細のページ）", () => {
  describe("正常系", () => {
    it("実行 1 件と、この実行に近い誤った書き込みの候補だけを出す", async () => {
      const run = makeRun();
      plane.getRun.mockResolvedValue(run);
      plane.listMiswriteCandidates.mockResolvedValue([candidate(SAMPLE_RUN_ID, 1), candidate(OTHER_RUN_ID, 2), candidate(null, 3)]);
      const element = await render(SAMPLE_RUN_ID);
      expect(plane.getRun).toHaveBeenCalledWith(SAMPLE_RUN_ID);
      expect(element.type).toBe(mocks.RunDetailView);
      expect(element.props.run).toBe(run);
      expect(element.props.candidates.map((c) => c.messageId)).toEqual([1]);
    });

    it("空入力: 候補が 0 件なら空の一覧を渡す", async () => {
      plane.getRun.mockResolvedValue(makeRun());
      const element = await render(SAMPLE_RUN_ID);
      expect(element.props.candidates).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 未ログインなら（requirePageSession が /login へ送り）何も読まない", async () => {
      mocks.requirePageSession.mockRejectedValue(new Error("NEXT_REDIRECT /login"));
      await expect(render(SAMPLE_RUN_ID)).rejects.toThrow("NEXT_REDIRECT /login");
      expect(plane.getRun).not.toHaveBeenCalled();
    });

    it.each([
      ["小文字", SAMPLE_RUN_ID.toLowerCase()],
      ["25 文字", SAMPLE_RUN_ID.slice(1)],
      ["パスの区切りを含む", `../${SAMPLE_RUN_ID.slice(3)}`],
    ])("入力: ID が ULID でない（%s）なら 404 にし、control-plane に問い合わせない", async (_label, runId) => {
      await expect(render(runId)).rejects.toThrow(NEXT_NOT_FOUND);
      expect(plane.getRun).not.toHaveBeenCalled();
      expect(plane.listMiswriteCandidates).not.toHaveBeenCalled();
    });

    it("空入力: ID が空文字なら 404 にし、control-plane に問い合わせない", async () => {
      await expect(render("")).rejects.toThrow(NEXT_NOT_FOUND);
      expect(plane.getRun).not.toHaveBeenCalled();
    });

    it("入力: 見つからない run_id なら 404 にする", async () => {
      await expect(render(SAMPLE_RUN_ID)).rejects.toThrow(NEXT_NOT_FOUND);
      expect(mocks.notFound).toHaveBeenCalledTimes(1);
    });

    it("サーバ: control-plane が使えなければ、ID の検証より先に原因の画面を出す", async () => {
      mocks.getControlPlaneState.mockReturnValue({ plane: null, error: "CONTROL_DATA_DIR: 必須" });
      const element = await render("not-a-ulid");
      expect(element.type).toBe(mocks.ConfigErrorView);
      expect(element.props).toEqual({ message: "CONTROL_DATA_DIR: 必須" });
      expect(mocks.notFound).not.toHaveBeenCalled();
    });

    it("サーバ: 実行の読み出しの例外は握りつぶさない", async () => {
      plane.getRun.mockRejectedValue(new Error("SQLITE_CORRUPT"));
      await expect(render(SAMPLE_RUN_ID)).rejects.toThrow("SQLITE_CORRUPT");
    });

    it("サーバ: 候補の照会（Chatwoot）の例外も握りつぶさない", async () => {
      plane.getRun.mockResolvedValue(makeRun());
      plane.listMiswriteCandidates.mockRejectedValue(new Error("Chatwoot 503"));
      await expect(render(SAMPLE_RUN_ID)).rejects.toThrow("Chatwoot 503");
    });
  });
});
