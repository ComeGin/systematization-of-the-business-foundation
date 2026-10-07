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
  describe("正常系", () => {
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

    it("空入力: ボディの無い POST も検証せずに Better Auth のハンドラに渡す（検証は Better Auth に任せる）", async () => {
      const request = new Request(`${URL_BASE}/sign-out`, { method: "POST" });
      await POST(request);
      expect(mocks.handlerPOST).toHaveBeenCalledWith(request);
    });

    it("Better Auth の拒否の応答（許可リスト外の 403 など）を書き換えずに返す", async () => {
      const refused = Response.json({ code: "FORBIDDEN" }, { status: 403 });
      mocks.handlerGET.mockResolvedValue(refused);
      await expect(GET(new Request(`${URL_BASE}/callback/google?code=x`))).resolves.toBe(refused);
    });
  });

  describe("異常系", () => {
    it("サーバ: スキーマの準備に失敗したら Better Auth のハンドラを呼ばない", async () => {
      mocks.ensureAuthSchema.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
      await expect(POST(new Request(`${URL_BASE}/sign-in/social`, { method: "POST" }))).rejects.toThrow("SQLITE_CANTOPEN");
      expect(mocks.handlerPOST).not.toHaveBeenCalled();
      expect(mocks.getAuth).not.toHaveBeenCalled();
    });

    it("サーバ: GET でもスキーマの準備に失敗したら Better Auth のハンドラを呼ばない", async () => {
      mocks.ensureAuthSchema.mockRejectedValue(new Error("SQLITE_CANTOPEN"));
      await expect(GET(new Request(`${URL_BASE}/get-session`))).rejects.toThrow("SQLITE_CANTOPEN");
      expect(mocks.handlerGET).not.toHaveBeenCalled();
    });

    it("サーバ: Better Auth のインスタンスを作れない（DB を開けない）ときは例外をそのまま返す", async () => {
      mocks.getAuth.mockImplementation(() => {
        throw new Error("EACCES: auth.sqlite");
      });
      await expect(GET(new Request(`${URL_BASE}/get-session`))).rejects.toThrow("EACCES");
      expect(mocks.toNextJsHandler).not.toHaveBeenCalled();
    });

    it("サーバ: Better Auth のハンドラの例外は握りつぶさない", async () => {
      mocks.handlerPOST.mockRejectedValue(new Error("Google の token エンドポイントに届かない"));
      await expect(POST(new Request(`${URL_BASE}/sign-in/social`, { method: "POST", body: "{}" }))).rejects.toThrow(
        "token エンドポイント",
      );
    });
  });
});
