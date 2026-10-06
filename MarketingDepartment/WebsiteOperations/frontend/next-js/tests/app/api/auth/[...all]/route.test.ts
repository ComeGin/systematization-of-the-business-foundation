import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const auth = { id: "auth-instance" };
  const handlerGET = vi.fn(async (_request: Request) => new Response("get"));
  const handlerPOST = vi.fn(async (_request: Request) => new Response("post"));
  return {
    order,
    auth,
    handlerGET,
    handlerPOST,
    ensureAuthSchema: vi.fn(async () => {
      order.push("ensureAuthSchema");
    }),
    getAuth: vi.fn(() => {
      order.push("getAuth");
      return auth;
    }),
    toNextJsHandler: vi.fn((_auth: unknown) => ({ GET: handlerGET, POST: handlerPOST })),
  };
});

vi.mock("@/lib/auth", () => ({ ensureAuthSchema: mocks.ensureAuthSchema, getAuth: mocks.getAuth }));
vi.mock("better-auth/next-js", () => ({ toNextJsHandler: mocks.toNextJsHandler }));

import { GET, POST } from "@/app/api/auth/[...all]/route";

const URL_BASE = "http://127.0.0.1:3200/api/auth";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order.length = 0;
});

describe("/api/auth/[...all]", () => {
  it("モジュールの読み込みだけでは DB を開かない（next build のデータ収集に備える）", () => {
    expect(mocks.getAuth).not.toHaveBeenCalled();
    expect(mocks.ensureAuthSchema).not.toHaveBeenCalled();
  });

  it("GET はスキーマを準備してから Better Auth のハンドラに要求をそのまま渡す", async () => {
    const request = new Request(`${URL_BASE}/get-session`);
    const res = await GET(request);
    expect(await res.text()).toBe("get");
    expect(mocks.order).toEqual(["ensureAuthSchema", "getAuth"]);
    expect(mocks.toNextJsHandler).toHaveBeenCalledWith(mocks.auth);
    expect(mocks.handlerGET).toHaveBeenCalledWith(request);
  });

  it("POST も同じくスキーマを準備してから Better Auth のハンドラに渡す", async () => {
    const request = new Request(`${URL_BASE}/sign-in/social`, { method: "POST", body: "{}" });
    const res = await POST(request);
    expect(await res.text()).toBe("post");
    expect(mocks.order).toEqual(["ensureAuthSchema", "getAuth"]);
    expect(mocks.handlerPOST).toHaveBeenCalledWith(request);
  });

  it("スキーマの準備に失敗したら Better Auth のハンドラを呼ばない", async () => {
    mocks.ensureAuthSchema.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
    await expect(POST(new Request(`${URL_BASE}/sign-in/social`, { method: "POST" }))).rejects.toThrow("SQLITE_CANTOPEN");
    expect(mocks.handlerPOST).not.toHaveBeenCalled();
    expect(mocks.getAuth).not.toHaveBeenCalled();
  });
});
