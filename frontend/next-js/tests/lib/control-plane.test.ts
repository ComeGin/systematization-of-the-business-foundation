import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePlane } from "../helpers/control-plane";

const mocks = vi.hoisted(() => ({
  createControlPlane: vi.fn(),
}));

vi.mock("control-plane", () => ({ createControlPlane: mocks.createControlPlane }));

import { getControlPlaneState, startControlPlane } from "@/lib/control-plane";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__comeginControlPlane = undefined;
});

describe("getControlPlaneState", () => {
  describe("正常系", () => {
    it("初期化に成功したら plane を持ち、プロセスで 1 つだけ作る（globalThis に置く）", () => {
      const plane = createFakePlane();
      mocks.createControlPlane.mockReturnValue(plane);
      const first = getControlPlaneState();
      const second = getControlPlaneState();
      expect(first).toEqual({ plane, error: null });
      expect(second).toBe(first);
      expect(globalThis.__comeginControlPlane).toBe(first);
      expect(mocks.createControlPlane).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("入力: ConfigError（name で判定）はメッセージ（変数名と理由だけ）をそのまま画面用に持つ", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.createControlPlane.mockImplementation(() => {
        throw namedError("ConfigError", "CONTROL_MAIN_CHECKOUT: 絶対パスでない");
      });
      expect(getControlPlaneState()).toEqual({ plane: null, error: "CONTROL_MAIN_CHECKOUT: 絶対パスでない" });
      expect(consoleError).not.toHaveBeenCalled();
    });

    it("空入力: 必須の環境変数が未設定（ConfigError）なら plane を持たず、原因を画面用に持つ", () => {
      mocks.createControlPlane.mockImplementation(() => {
        throw namedError("ConfigError", "CONTROL_WORKTREE: 必須");
      });
      const state = getControlPlaneState();
      expect(state.plane).toBeNull();
      expect(state.error).toBe("CONTROL_WORKTREE: 必須");
    });

    it("サーバ: ConfigError 以外の失敗は詳細を画面用に持たず、stderr にだけ出す", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.createControlPlane.mockImplementation(() => {
        throw new Error("EACCES: /home/someone/.local/share/comegin-control");
      });
      const state = getControlPlaneState();
      expect(state.plane).toBeNull();
      expect(state.error).not.toContain("EACCES");
      expect(state.error).toContain("stderr");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("EACCES");
    });

    it("サーバ: Error でない値が投げられても plane を持たず、ログには「不明」とだけ残す", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.createControlPlane.mockImplementation(() => {
        throw "sqlite crashed";
      });
      const state = getControlPlaneState();
      expect(state.plane).toBeNull();
      expect(state.error).toContain("stderr");
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("不明");
    });

    it("サーバ: 失敗した状態も覚えておき、要求のたびに作り直さない", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.createControlPlane.mockImplementation(() => {
        throw namedError("ConfigError", "X: 不正");
      });
      getControlPlaneState();
      getControlPlaneState();
      expect(mocks.createControlPlane).toHaveBeenCalledTimes(1);
    });
  });
});

describe("startControlPlane", () => {
  describe("正常系", () => {
    it("初期化に成功していれば start() を呼ぶ", async () => {
      const plane = createFakePlane();
      mocks.createControlPlane.mockReturnValue(plane);
      await startControlPlane();
      expect(plane.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("空入力: control-plane が無い（初期化に失敗）なら start を呼ばず、例外も投げない（サーバーは起動し、画面に原因を出す）", async () => {
      mocks.createControlPlane.mockImplementation(() => {
        throw namedError("ConfigError", "X: 不正");
      });
      await expect(startControlPlane()).resolves.toBeUndefined();
    });

    it("サーバ: start() の失敗（スケジューラの開始で DB を開けないなど）は握りつぶさずに返す", async () => {
      const plane = createFakePlane();
      plane.start.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
      mocks.createControlPlane.mockReturnValue(plane);
      await expect(startControlPlane()).rejects.toThrow("SQLITE_CANTOPEN");
    });
  });
});
