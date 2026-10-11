// 監視アプリ（127.0.0.1:3200）を、セッション無しで外から叩く結合テスト。
// 設計は frontend/next-js/README.md（Route Handler はすべてログイン必須で 401、画面は /login へ）。
// セッションのある場合はインプロセスの結合テスト（frontend/next-js/integration/）が受け持つ。
//
// Google には繋がない。ソーシャルログインの開始が返す認可 URL の中身を確かめるだけで、遷移しない。
// 開始のたびに state の行（verification）が監視アプリの認証 DB にできるので、afterAll で消す。
import { afterAll, describe, expect, it } from "vitest";

import { Cleanup } from "../helpers/cleanup.ts";
import { http, type HttpResult } from "../helpers/http.ts";
import { itEmail } from "../helpers/run-id.ts";
import { DEV } from "../helpers/services.ts";
import { deleteVerification } from "./auth-db.ts";

const BASE = DEV.nextJs;
// 開発サーバーは初回のアクセスでページをコンパイルするので、待ち時間を長めにする
const TIMEOUT_MS = 45_000;
// 形は正しい（ULID）が、存在しない実行の ID
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Better Auth のセッションの Cookie（https の BETTER_AUTH_URL では __Secure- が付く）に偽の値を入れる
const FORGED_SESSION_COOKIE = "__Secure-better-auth.session_token=it-forged.signature; better-auth.session_token=it-forged.signature";

const API_PATHS = ["/api/runs", "/api/jobs", "/api/miswrite-candidates", `/api/runs/${RUN_ID}`];
const CONSOLE_PAGES = ["/runs", "/runs/new", `/runs/${RUN_ID}`, "/jobs", "/jobs/it-unknown-job", "/miswrite-candidates"];

interface ErrorBody {
  error?: string;
  code?: string;
  message?: string;
  url?: string;
}

const cleanup = new Cleanup();

afterAll(async () => {
  await cleanup.runAll();
});

const get = <T = ErrorBody>(path: string, headers: Record<string, string> = {}) => http<T>(`${BASE}${path}`, { headers, timeoutMs: TIMEOUT_MS });

/** ソーシャルログインを開始する（Google には遷移しない）。認可 URL が返れば state の行を後片付けに登録する */
async function startSocialSignIn(body: unknown): Promise<HttpResult<ErrorBody & { redirect?: boolean }>> {
  const res = await http<ErrorBody & { redirect?: boolean }>(`${BASE}/api/auth/sign-in/social`, { method: "POST", body, timeoutMs: TIMEOUT_MS });
  const state = res.json?.url ? new URL(res.json.url).searchParams.get("state") : null;
  if (state) cleanup.add("ソーシャルログインの state の行", async () => deleteVerification(state));
  return res;
}

/**
 * 監視アプリの BETTER_AUTH_URL のオリジン（Better Auth が信頼するオリジン）。環境変数ファイルは読まないので、
 * ソーシャルログインの開始が返す redirect_uri（<BETTER_AUTH_URL>/api/auth/callback/google）から求める
 */
let trustedOriginCache: string | undefined;
async function trustedOrigin(): Promise<string> {
  if (!trustedOriginCache) {
    const res = await startSocialSignIn({ provider: "google", callbackURL: "/runs" });
    trustedOriginCache = new URL(new URL(res.json!.url!).searchParams.get("redirect_uri")!).origin;
  }
  return trustedOriginCache;
}

const signUp = (options: { origin?: string }) =>
  http<ErrorBody>(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: options.origin ? { origin: options.origin } : {},
    body: { email: itEmail("next-js-signup"), password: "it-password-0123456789", name: "it-next-js" },
    timeoutMs: TIMEOUT_MS,
  });

const locationPath = (res: HttpResult) => new URL(res.headers.get("location") ?? "", BASE).pathname;

describe("ログインの画面と Better Auth の公開エンドポイント", () => {
  describe("正常系", () => {
    it("/login はセッション無しで 200 の HTML を返す", async () => {
      const res = await get("/login");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    it("空入力: Cookie 無しの /api/auth/get-session は 200 で null（セッションが無い）", async () => {
      const res = await get("/api/auth/get-session");

      expect(res.status).toBe(200);
      expect(res.text).toBe("null");
    });

    it("Google のログインの開始は Google の認可 URL を返し、hd・select_account・PKCE（S256）・監視アプリのコールバックが付く", async () => {
      const res = await startSocialSignIn({ provider: "google", callbackURL: "/runs" });

      expect(res.status).toBe(200);
      const url = new URL(res.json!.url!);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("hd")).toBe("comegin.com");
      expect(url.searchParams.get("prompt")).toBe("select_account");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(new URL(url.searchParams.get("redirect_uri")!).pathname).toBe("/api/auth/callback/google");
      expect(res.headers.getSetCookie().find((c) => c.includes("better-auth.state"))).toMatch(/HttpOnly/);
    });
  });

  describe("異常系", () => {
    it("入力: 偽のセッションの Cookie でも get-session は null", async () => {
      const res = await get("/api/auth/get-session", { cookie: FORGED_SESSION_COOKIE });

      expect(res.status).toBe(200);
      expect(res.text).toBe("null");
    });

    it("入力: 別サイトの callbackURL は 403 INVALID_CALLBACK_URL で、認可 URL を返さない", async () => {
      const res = await startSocialSignIn({ provider: "google", callbackURL: "https://evil.example/after-login" });

      expect(res.status).toBe(403);
      expect(res.json?.code).toBe("INVALID_CALLBACK_URL");
      expect(res.json?.url).toBeUndefined();
    });

    it("入力: Google 以外のプロバイダー（github）は 404", async () => {
      const res = await startSocialSignIn({ provider: "github", callbackURL: "/runs" });

      expect(res.status).toBe(404);
      expect(res.json?.url).toBeUndefined();
    });

    it("空入力: provider が無ければ 400", async () => {
      const res = await startSocialSignIn({});

      expect(res.status).toBe(400);
      expect(res.json?.url).toBeUndefined();
    });

    it("入力: メールとパスワードのサインアップは無効で、セッションの Cookie を返さない", async () => {
      const res = await signUp({ origin: await trustedOrigin() });

      expect(res.status).toBe(400);
      expect(res.json?.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
      expect(res.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
    });

    it("入力: 別サイトの Origin からの書き込み（サインアップ）は 403 で、無効の判定より先に止める", async () => {
      const res = await signUp({ origin: "https://evil.example" });

      expect(res.status).toBe(403);
      expect(res.json?.code).not.toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    });

    it("空入力: Origin の無い fetch からの書き込みは 403 MISSING_OR_NULL_ORIGIN", async () => {
      const res = await signUp({});

      expect(res.status).toBe(403);
      expect(res.json?.code).toBe("MISSING_OR_NULL_ORIGIN");
    });
  });
});

describe("Route Handler（/api/runs ほか）", () => {
  describe("異常系", () => {
    it.each(API_PATHS)("入力: セッション無しの GET %s は 401 unauthorized", async (path) => {
      const res = await get(path);

      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });

    it.each(API_PATHS)("入力: 偽のセッションの Cookie でも GET %s は 401", async (path) => {
      const res = await get(path, { cookie: FORGED_SESSION_COOKIE });

      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });

    it("入力: 形の不正な run_id・クエリでも、ログインの確認が先で 401（検証の結果を未ログインに見せない）", async () => {
      const badId = await get("/api/runs/not-a-ulid");
      const badQuery = await get("/api/runs?limit=abc&outcome=it-unknown");

      expect(badId.status).toBe(401);
      expect(badQuery.status).toBe(401);
    });

    it("入力: セッション無しの手動の起動（POST /api/runs）は、正しい本文でも 401 で受け付けない", async () => {
      const res = await http<ErrorBody>(`${BASE}/api/runs`, {
        method: "POST",
        headers: { origin: BASE },
        body: { target: { kind: "job", jobId: "it-unknown-job" } },
        timeoutMs: TIMEOUT_MS,
      });

      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });

    it("入力: 別サイトからの POST /api/runs も 401（ログインの確認が先）", async () => {
      const res = await http<ErrorBody>(`${BASE}/api/runs`, {
        method: "POST",
        headers: { origin: "https://evil.example", cookie: FORGED_SESSION_COOKIE },
        body: { target: { kind: "agent", agent: "content-writer", prompt: "it-prompt" } },
        timeoutMs: TIMEOUT_MS,
      });

      expect(res.status).toBe(401);
    });

    it("空入力: 本文の無い POST /api/runs も 401", async () => {
      const res = await http<ErrorBody>(`${BASE}/api/runs`, { method: "POST", headers: { origin: BASE }, timeoutMs: TIMEOUT_MS });

      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "unauthorized" });
    });
  });
});

describe("コンソールの画面", () => {
  describe("異常系", () => {
    it.each(CONSOLE_PAGES)("入力: セッション無しの %s は /login へリダイレクトする", async (path) => {
      const res = await get(path);

      expect([302, 303, 307, 308]).toContain(res.status);
      expect(locationPath(res)).toBe("/login");
    });

    it("入力: 偽のセッションの Cookie でも /runs は /login へリダイレクトする", async () => {
      const res = await get("/runs", { cookie: FORGED_SESSION_COOKIE });

      expect([302, 303, 307, 308]).toContain(res.status);
      expect(locationPath(res)).toBe("/login");
    });

    it("空入力: 入口（/）は実行の一覧かログインへ送り、中身を返さない", async () => {
      const res = await get("/");

      expect([302, 303, 307, 308]).toContain(res.status);
      expect(["/login", "/runs"]).toContain(locationPath(res));
    });
  });
});
