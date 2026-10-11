import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    ensureAuthSchema: vi.fn(async () => {
      order.push("ensureAuthSchema");
    }),
    startControlPlane: vi.fn(async () => {
      order.push("startControlPlane");
    }),
  };
});

vi.mock("@/lib/auth", () => ({ ensureAuthSchema: mocks.ensureAuthSchema }));
vi.mock("@/lib/control-plane", () => ({ startControlPlane: mocks.startControlPlane }));

import { register } from "@/instrumentation";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "phase-development-server");
});

describe("register", () => {
  describe("正常系", () => {
    it("Node.js のランタイムでは、ログイン用 DB を準備してから control-plane を開始する", async () => {
      await register();
      expect(mocks.order).toEqual(["ensureAuthSchema", "startControlPlane"]);
    });

    it("空入力: NEXT_PHASE が未設定（next start）でも起動する", async () => {
      vi.stubEnv("NEXT_PHASE", undefined);
      await register();
      expect(mocks.order).toEqual(["ensureAuthSchema", "startControlPlane"]);
    });

    it("Edge のランタイムでは何もしない（node:sqlite が使えない）", async () => {
      vi.stubEnv("NEXT_RUNTIME", "edge");
      await register();
      expect(mocks.ensureAuthSchema).not.toHaveBeenCalled();
      expect(mocks.startControlPlane).not.toHaveBeenCalled();
    });

    it("next build の間は何も起動しない（定期実行・ハートビートを走らせない）", async () => {
      vi.stubEnv("NEXT_PHASE", "phase-production-build");
      await register();
      expect(mocks.ensureAuthSchema).not.toHaveBeenCalled();
      expect(mocks.startControlPlane).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("空入力: NEXT_RUNTIME が未設定なら何もしない（Node.js と確かめられないときは起動しない）", async () => {
      vi.stubEnv("NEXT_RUNTIME", undefined);
      await register();
      expect(mocks.ensureAuthSchema).not.toHaveBeenCalled();
      expect(mocks.startControlPlane).not.toHaveBeenCalled();
    });

    it("サーバ: ログイン用 DB の準備に失敗しても、ログに残して control-plane は開始する", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.ensureAuthSchema.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
      await expect(register()).resolves.toBeUndefined();
      expect(mocks.startControlPlane).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("SQLITE_CANTOPEN");
    });

    it("サーバ: Error でない値で失敗しても、ログには「不明」とだけ残して control-plane は開始する", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.ensureAuthSchema.mockRejectedValue("secret-value");
      await expect(register()).resolves.toBeUndefined();
      expect(mocks.startControlPlane).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("不明");
      expect(String(consoleError.mock.calls[0]?.[0])).not.toContain("secret-value");
    });

    it("サーバ: control-plane の開始の失敗は握りつぶさずに返す", async () => {
      mocks.startControlPlane.mockRejectedValue(new Error("SQLITE_CANTOPEN e15.sqlite"));
      await expect(register()).rejects.toThrow("SQLITE_CANTOPEN");
      expect(mocks.ensureAuthSchema).toHaveBeenCalledTimes(1);
    });
  });
});
