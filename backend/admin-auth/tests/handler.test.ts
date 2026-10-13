import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Handle } from "../src/handler.js";
import { captureStderr, DB_PASSWORD } from "./helpers/env.js";

// handler.ts（入口に依存しない本体）の検査。auth は偽物（Better Auth の中身は auth.test.ts）
const BASE = "http://localhost:3103";
let authHandler: ReturnType<typeof vi.fn<(req: Request) => Promise<Response>>>;
let handle: Handle;
let stderr: ReturnType<typeof captureStderr>;

beforeEach(() => {
  stderr = captureStderr();
  authHandler = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  handle = createHandler({ auth: { handler: authHandler } });
});

const call = (method: string, path: string, init: RequestInit = {}) => handle(new Request(`${BASE}${path}`, { method, ...init }));
const lastLog = () => JSON.parse(String(stderr.spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

describe("振り分け", () => {
  describe("正常系", () => {
    it("GET /healthz は DB（auth）に触れずに 200 ok を返す", async () => {
      const res = await call("GET", "/healthz");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(authHandler).not.toHaveBeenCalled();
    });

    it("HEAD /healthz も 200", async () => {
      expect((await call("HEAD", "/healthz")).status).toBe(200);
    });

    it("/api/auth/ 配下は、メソッドと本文を保ったまま Better Auth に渡す", async () => {
      await call("POST", "/api/auth/oauth2/token", { body: "grant_type=authorization_code", headers: { "content-type": "application/x-www-form-urlencoded" } });
      const req = authHandler.mock.calls[0]![0];
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/api/auth/oauth2/token");
      expect(await req.text()).toBe("grant_type=authorization_code");
    });

    it("ルート直下の openid-configuration は、クエリを保ったまま issuer 配下に付け替えて渡す", async () => {
      await call("GET", "/.well-known/openid-configuration?x=1");
      const url = new URL(authHandler.mock.calls[0]![0].url);
      expect(url.pathname).toBe("/api/auth/.well-known/openid-configuration");
      expect(url.search).toBe("?x=1");
    });

    it("ルート直下の oauth-authorization-server も付け替える", async () => {
      await call("GET", "/.well-known/oauth-authorization-server");
      expect(new URL(authHandler.mock.calls[0]![0].url).pathname).toBe("/api/auth/.well-known/oauth-authorization-server");
    });

    it("RFC 8414 の issuer を後ろに付ける形は、付け替えずにそのまま渡す", async () => {
      await call("GET", "/.well-known/oauth-authorization-server/api/auth");
      expect(new URL(authHandler.mock.calls[0]![0].url).pathname).toBe("/.well-known/oauth-authorization-server/api/auth");
    });

    it("Better Auth の応答（複数の Set-Cookie を含む）をそのまま返す", async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      authHandler.mockResolvedValue(new Response(null, { status: 302, headers }));
      const res = await call("GET", "/api/auth/callback/google");
      expect(res.status).toBe(302);
      expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    });

    it("GET /sign-in はログイン画面を、CSP とキャッシュ禁止のヘッダー付きで返す", async () => {
      const res = await call("GET", "/sign-in?client_id=a&sig=s");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("管理画面へのログイン");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("GET /consent は同意画面を返す", async () => {
      expect(await (await call("GET", "/consent")).text()).toContain("skip_consent");
    });

    it("GET /error は error クエリに応じた文言を返す", async () => {
      expect(await (await call("GET", "/error?error=FORBIDDEN")).text()).toContain("許可リスト");
    });

    it("空入力: GET /error に error クエリが無ければ既定の文言を返す", async () => {
      expect(await (await call("GET", "/error")).text()).toContain("ログインに失敗しました");
    });

    it("空入力: / は 404 not found", async () => {
      const res = await call("GET", "/");
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
      expect(authHandler).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("入力: POST /healthz は 404", async () => {
      expect((await call("POST", "/healthz")).status).toBe(404);
    });

    it("入力: /api/auth（末尾のスラッシュ無し）と似た名前のパスは Better Auth に渡さない", async () => {
      expect((await call("GET", "/api/auth")).status).toBe(404);
      expect((await call("GET", "/api/authx/jwks")).status).toBe(404);
      expect(authHandler).not.toHaveBeenCalled();
    });

    it("入力: GET 以外の discovery は付け替えない", async () => {
      await call("POST", "/.well-known/openid-configuration");
      expect(new URL(authHandler.mock.calls[0]![0].url).pathname).toBe("/.well-known/openid-configuration");
    });

    it("入力: GET /error はクエリの値を埋め込まない", async () => {
      expect(await (await call("GET", `/error?error=${encodeURIComponent("<script>x</script>")}`)).text()).not.toContain("<script>x</script>");
    });

    it("入力: POST /sign-in は 404", async () => {
      expect((await call("POST", "/sign-in")).status).toBe(404);
    });

    it("サーバ: Better Auth が投げたら 500 internal error で、本文に例外の中身を出さない", async () => {
      authHandler.mockRejectedValue(new Error(`password authentication failed: ${DB_PASSWORD}`));
      const res = await call("POST", "/api/auth/oauth2/token");
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toBe("internal error");
      expect(body).not.toContain(DB_PASSWORD);
    });
  });
});

describe("アクセスログ", () => {
  describe("正常系", () => {
    it("JSON の 1 行で、メソッド・パス・ステータス・所要時間を出し、クエリ（認可コードや署名）は出さない", async () => {
      await call("GET", "/sign-in?code=SECRETCODE&sig=SIGVALUE");
      const line = String(stderr.spy.mock.calls.at(-1)?.[0]);
      expect(lastLog()).toMatchObject({ method: "GET", path: "/sign-in", status: 200 });
      expect(typeof lastLog().ms).toBe("number");
      expect(line).not.toContain("SECRETCODE");
      expect(line).not.toContain("SIGVALUE");
    });

    it("付け替えた discovery は、付け替え後のパスで記録する", async () => {
      await call("GET", "/.well-known/openid-configuration?state=STATEVALUE");
      expect(lastLog().path).toBe("/api/auth/.well-known/openid-configuration");
      expect(String(stderr.spy.mock.calls.at(-1)?.[0])).not.toContain("STATEVALUE");
    });
  });

  describe("異常系", () => {
    it("サーバ: 500 のときもステータスつきで 1 行出す", async () => {
      authHandler.mockRejectedValue(new Error("boom"));
      await call("GET", "/api/auth/jwks");
      expect(lastLog()).toMatchObject({ path: "/api/auth/jwks", status: 500 });
    });

    it("空入力: 本文の無い 404 も記録する", async () => {
      await call("GET", "/nothing");
      expect(lastLog()).toMatchObject({ status: 404 });
    });
  });
});
