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
  it("Node.js のランタイムでは、ログイン用 DB を準備してから control-plane を開始する", async () => {
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

  it("ログイン用 DB の準備に失敗しても、ログに残して control-plane は開始する", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.ensureAuthSchema.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.startControlPlane).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("SQLITE_CANTOPEN");
  });
});
