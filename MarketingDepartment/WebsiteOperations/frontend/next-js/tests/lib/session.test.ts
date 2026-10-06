import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const requestHeaders = new Headers({ cookie: "better-auth.session_token=abc" });
  return {
    order,
    requestHeaders,
    headers: vi.fn(async () => {
      order.push("headers");
      return requestHeaders;
    }),
    redirect: vi.fn((url: string): never => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    }),
    ensureAuthSchema: vi.fn(async () => {
      order.push("ensureAuthSchema");
    }),
    getSession: vi.fn(async (_input: { headers: Headers }): Promise<unknown> => null),
  };
});

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth", () => ({
  ensureAuthSchema: mocks.ensureAuthSchema,
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

import { getSession, guardApiRequest, requirePageSession } from "@/lib/session";

const SESSION = { user: { id: "u1", email: "admin@comegin.com" }, session: { id: "s1" } };

function apiRequest(method: string, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3200/api/runs", { method, headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order.length = 0;
});

describe("getSession", () => {
  it("headers() を読んでからスキーマを準備し、要求のヘッダーで Better Auth に問い合わせる", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(getSession()).resolves.toBe(SESSION);
    expect(mocks.order).toEqual(["headers", "ensureAuthSchema"]);
    expect(mocks.getSession).toHaveBeenCalledWith({ headers: mocks.requestHeaders });
  });
});

describe("requirePageSession", () => {
  it("未ログインなら /login へリダイレクトする", async () => {
    await expect(requirePageSession()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("ログイン済みならセッションを返す", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(requirePageSession()).resolves.toBe(SESSION);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("guardApiRequest", () => {
  it("ログインの仕組みが使えないとき（スキーマの準備に失敗）は 503 を返す", async () => {
    mocks.ensureAuthSchema.mockRejectedValue(new Error("SQLITE_CANTOPEN /secret/path"));
    const res = await guardApiRequest(apiRequest("GET"));
    expect(res?.status).toBe(503);
    // 例外の詳細（パスなど）は応答に出さない
    expect(await res?.text()).not.toContain("/secret/path");
  });

  it("未ログインなら 401 を返す", async () => {
    const res = await guardApiRequest(apiRequest("GET"));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "unauthorized" });
  });

  it("未ログインなら、同じオリジンの POST でも 401 を返す（オリジンの検査より先）", async () => {
    const res = await guardApiRequest(apiRequest("POST", { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" }));
    expect(res?.status).toBe(401);
  });

  it.each(["GET", "HEAD"])("ログイン済みの %s は Origin が無くても通す", async (method) => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(guardApiRequest(apiRequest(method))).resolves.toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("ログイン済みでも、Origin の無い %s は 403 を返す", async (method) => {
    mocks.getSession.mockResolvedValue(SESSION);
    const res = await guardApiRequest(apiRequest(method, { host: "127.0.0.1:3200" }));
    expect(res?.status).toBe(403);
  });

  it("Host が無い POST は 403 を返す", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const res = await guardApiRequest(apiRequest("POST", { origin: "http://127.0.0.1:3200" }));
    expect(res?.status).toBe(403);
  });

  it("Origin が URL として読めない（null など）POST は 403 を返す", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    const res = await guardApiRequest(apiRequest("POST", { host: "127.0.0.1:3200", origin: "null" }));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "invalid origin" });
  });

  it.each([
    ["別のサイト", "https://evil.example.com"],
    ["ポートだけが違う", "http://127.0.0.1:3000"],
    ["別のホスト名に自分の名前を含めて装う", "http://127.0.0.1.evil.example.com:3200"],
  ])("Origin が自分のホストと違う POST（%s）は 403 を返す", async (_label, origin) => {
    mocks.getSession.mockResolvedValue(SESSION);
    const res = await guardApiRequest(apiRequest("POST", { host: "127.0.0.1:3200", origin }));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "cross-origin request" });
  });

  it("Origin のホストが Host と同じ POST は通す（ngrok の URL を含む）", async () => {
    mocks.getSession.mockResolvedValue(SESSION);
    await expect(
      guardApiRequest(apiRequest("POST", { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" })),
    ).resolves.toBeNull();
    await expect(
      guardApiRequest(
        apiRequest("POST", { host: "comegin-next-js-dev.ngrok.app", origin: "https://comegin-next-js-dev.ngrok.app" }),
      ),
    ).resolves.toBeNull();
  });
});
