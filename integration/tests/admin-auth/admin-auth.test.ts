// admin-auth（127.0.0.1:3103。Better Auth の OIDC Provider）を外から叩く結合テスト。PostgreSQL は compose の中の本物を使う。
// 設計は backend/admin-auth/README.md。issuer（BETTER_AUTH_URL）・hd（GOOGLE_HOSTED_DOMAIN）はコンテナの環境変数から 1 つずつ読む。
//
// Google には繋がない。ソーシャルログインの開始が返す認可 URL（accounts.google.com）の中身を確かめるだけで、遷移しない。
// 開始のたびに state の行（verification）が DB にできるので、afterAll で消す。
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Cleanup } from "../helpers/cleanup.ts";
import { withPaused } from "../helpers/docker.ts";
import { http, type HttpResult } from "../helpers/http.ts";
import { itEmail } from "../helpers/run-id.ts";
import { CONTAINERS, DEV } from "../helpers/services.ts";
import { waitFor } from "../helpers/wait.ts";
import { adminAuthEnv, countUsersByEmail, deleteVerification, googleConfigured, registeredClient } from "./db.ts";
import { navigate } from "./navigate.ts";

const BASE = DEV.adminAuth;
const AUTH = `${BASE}/api/auth`;
// RSA の秘密鍵の成分（JWK）。公開鍵の集合に入っていてはいけない
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: string[];
  response_types_supported: string[];
  scopes_supported: string[];
  code_challenge_methods_supported: string[];
}

interface OAuthError {
  error?: string;
  error_description?: string;
  code?: string;
  message?: string;
}

let BETTER_AUTH_URL: string;
let HOSTED_DOMAIN: string;
const cleanup = new Cleanup();

beforeAll(async () => {
  BETTER_AUTH_URL = await adminAuthEnv("BETTER_AUTH_URL");
  HOSTED_DOMAIN = (await adminAuthEnv("GOOGLE_HOSTED_DOMAIN")) || "comegin.com";
  if (!BETTER_AUTH_URL) throw new Error("admin-auth のコンテナから BETTER_AUTH_URL を読めない");
});

afterAll(async () => {
  await cleanup.runAll();
});

const tokenRequest = (params: Record<string, string>, basic?: { id: string; secret: string }) =>
  http<OAuthError>(`${AUTH}/oauth2/token`, {
    method: "POST",
    headers: basic ? { authorization: `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString("base64")}` } : {},
    body: new URLSearchParams(params),
  });

/** ソーシャルログインを開始する（Google には遷移しない）。認可 URL が返れば state の行を後片付けに登録する */
async function startSocialSignIn(body: unknown): Promise<HttpResult<{ url?: string; redirect?: boolean } & OAuthError>> {
  const res = await http<{ url?: string; redirect?: boolean } & OAuthError>(`${AUTH}/sign-in/social`, {
    method: "POST",
    headers: { origin: BETTER_AUTH_URL },
    body,
  });
  const state = res.json?.url ? new URL(res.json.url).searchParams.get("state") : null;
  if (state) cleanup.add("ソーシャルログインの state の行", () => deleteVerification(state));
  return res;
}

/** 応答の状態。期限内に返らなければ "timeout"（DB を止めている間は、接続の取り方で 5xx にもタイムアウトにもなる） */
async function statusOrTimeout(request: Promise<HttpResult>): Promise<number | "timeout"> {
  try {
    return (await request).status;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
    throw error;
  }
}

describe("discovery（/.well-known/openid-configuration ほか）", () => {
  describe("正常系", () => {
    it("issuer は BETTER_AUTH_URL/api/auth で、各エンドポイントが issuer の配下にあり、ID トークンの署名は RS256 だけ", async () => {
      const res = await http<Discovery>(`${BASE}/.well-known/openid-configuration`);

      expect(res.status).toBe(200);
      const d = res.json!;
      const issuer = `${BETTER_AUTH_URL}/api/auth`;
      expect(d.issuer).toBe(issuer);
      expect(d.authorization_endpoint).toBe(`${issuer}/oauth2/authorize`);
      expect(d.token_endpoint).toBe(`${issuer}/oauth2/token`);
      expect(d.userinfo_endpoint).toBe(`${issuer}/oauth2/userinfo`);
      expect(d.jwks_uri).toBe(`${issuer}/jwks`);
      expect(d.id_token_signing_alg_values_supported).toEqual(["RS256"]);
      expect(d.response_types_supported).toEqual(["code"]);
      expect(d.scopes_supported).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
      expect(d.code_challenge_methods_supported).toEqual(["S256"]);
    });

    it("ルート直下の discovery は、issuer 配下（/api/auth/.well-known/…）と同じ内容を返す", async () => {
      const root = await http(`${BASE}/.well-known/openid-configuration`);
      const underIssuer = await http(`${AUTH}/.well-known/openid-configuration`);

      expect(underIssuer.status).toBe(200);
      expect(root.json).toEqual(underIssuer.json);
    });

    it("RFC 8414 のメタデータ（/.well-known/oauth-authorization-server と issuer のパス付き）も同じ issuer を返す", async () => {
      const root = await http<Discovery>(`${BASE}/.well-known/oauth-authorization-server`);
      const withPath = await http<Discovery>(`${BASE}/.well-known/oauth-authorization-server/api/auth`);

      expect(root.status).toBe(200);
      expect(withPath.status).toBe(200);
      expect(root.json?.issuer).toBe(`${BETTER_AUTH_URL}/api/auth`);
      expect(withPath.json?.issuer).toBe(root.json?.issuer);
    });
  });

  describe("異常系", () => {
    it("入力: 知らない .well-known のパスは discovery を返さない", async () => {
      const res = await http<Discovery>(`${BASE}/.well-known/it-unknown`);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.json?.issuer).toBeUndefined();
    });

    it("空入力: ルート（/）は 404", async () => {
      const res = await http(`${BASE}/`);

      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/auth/jwks", () => {
  describe("正常系", () => {
    it("RS256 の RSA 公開鍵だけを返し、秘密の成分（d・p・q など）を含まない", async () => {
      const res = await http<{ keys: Array<Record<string, unknown>> }>(`${AUTH}/jwks`);

      expect(res.status).toBe(200);
      const keys = res.json!.keys;
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatchObject({ kty: "RSA", alg: "RS256", e: expect.any(String), n: expect.any(String), kid: expect.any(String) });
        for (const member of PRIVATE_JWK_MEMBERS) expect(key).not.toHaveProperty(member);
      }
      expect(new Set(keys.map((k) => k.kid)).size).toBe(keys.length);
    });
  });

  describe("異常系", () => {
    it("サーバ: PostgreSQL が応答しない間は 5xx かタイムアウト（鍵は DB にある）で、再開後は 200 に戻る", async () => {
      const status = await withPaused(CONTAINERS.adminAuthPostgres, () => statusOrTimeout(http(`${AUTH}/jwks`, { timeoutMs: 10_000 })));

      expect(status === "timeout" || status >= 500).toBe(true);
      await waitFor(async () => (await http(`${AUTH}/jwks`)).status === 200, { timeoutMs: 30_000, what: "再開後に JWKS が 200 になる" });
    });
  });
});

describe("GET /healthz", () => {
  describe("正常系", () => {
    it("GET と HEAD に 200 ok を返す", async () => {
      const getRes = await http(`${BASE}/healthz`);
      const headRes = await http(`${BASE}/healthz`, { method: "HEAD" });

      expect(getRes.status).toBe(200);
      expect(getRes.text).toBe("ok");
      expect(headRes.status).toBe(200);
    });
  });

  describe("異常系", () => {
    it("入力: POST はヘルスチェックとして扱わず 404", async () => {
      const res = await http(`${BASE}/healthz`, { method: "POST" });

      expect(res.status).toBe(404);
    });

    it("サーバ: PostgreSQL が応答しなくても、healthz・discovery・ログイン画面は 200（DB を見ない）", async () => {
      const [health, discovery, signIn] = await withPaused(CONTAINERS.adminAuthPostgres, () =>
        Promise.all([
          http(`${BASE}/healthz`, { timeoutMs: 5_000 }),
          http(`${BASE}/.well-known/openid-configuration`, { timeoutMs: 5_000 }),
          http(`${BASE}/sign-in`, { timeoutMs: 5_000 }),
        ]),
      );

      expect(health.status).toBe(200);
      expect(discovery.status).toBe(200);
      expect(signIn.status).toBe(200);
    });
  });
});

describe("内蔵の画面（/sign-in・/error・/consent）", () => {
  describe("正常系", () => {
    it("/sign-in は nonce 付きの CSP で、インラインのスクリプトとスタイルはその nonce を持ち、外部のスクリプト・画像を読まない", async () => {
      const res = await http(`${BASE}/sign-in`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const csp = res.headers.get("content-security-policy")!;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      const scripts = res.text.match(/<script[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) {
        expect(tag).toContain(`nonce="${nonce}"`);
        expect(tag).not.toMatch(/\ssrc=/);
      }
      expect(res.text).toContain(`<style nonce="${nonce}">`);
      expect(res.text).not.toMatch(/<(img|link|iframe)\b/);
    });

    it("nonce はリクエストごとに変わる", async () => {
      const a = (await http(`${BASE}/sign-in`)).headers.get("content-security-policy");
      const b = (await http(`${BASE}/sign-in`)).headers.get("content-security-policy");

      expect(a).not.toBe(b);
    });

    it("/error?error=FORBIDDEN は許可リストの案内を出し、/consent も 200 を返す", async () => {
      const error = await http(`${BASE}/error?error=FORBIDDEN`);
      const consent = await http(`${BASE}/consent`);

      expect(error.status).toBe(200);
      expect(error.text).toContain("許可リスト");
      expect(error.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(consent.status).toBe(200);
    });

    it("空入力: /error にコードが無ければ既定の文言を出す", async () => {
      const res = await http(`${BASE}/error`);

      expect(res.status).toBe(200);
      expect(res.text).toContain("ログインに失敗しました");
    });
  });

  describe("異常系", () => {
    it("入力: /error のコードに HTML を入れても、そのまま埋め込まない（既定の文言になる）", async () => {
      const res = await http(`${BASE}/error?error=${encodeURIComponent("<script>alert(1)</script>")}`);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain("<script>alert(1)</script>");
      expect(res.text).toContain("ログインに失敗しました");
    });

    // src/pages.ts は Object.hasOwn で自前のキーだけを見る（c69f03bf で修正）。それより前にビルドしたコンテナでは
    // ERROR_MESSAGES["__proto__"] が Object.prototype になり「[object Object]」と出る。失敗したら docker compose up -d --build で作り直す
    it("入力: /error のコードにプロトタイプのプロパティ名（__proto__）を入れても既定の文言になる", async () => {
      const res = await http(`${BASE}/error?error=__proto__`);

      expect(res.status).toBe(200);
      expect(res.text).toContain("ログインに失敗しました");
    });

    it("入力: 画面への POST は 404", async () => {
      const res = await http(`${BASE}/sign-in`, { method: "POST" });

      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/auth/oauth2/authorize", () => {
  describe("正常系", () => {
    it("登録済みのクライアントで未ログインなら、署名つきの認可リクエストを持って /sign-in へ 302 で送る", async (ctx) => {
      const client = await registeredClient();
      if (!client) return ctx.skip(); // ALB のクライアントが未登録（register-alb-client.ts を未実行）なら確かめられない

      const query = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, scope: "openid email profile", state: "it-state", nonce: "it-nonce" });
      const res = await navigate(`${AUTH}/oauth2/authorize?${query}`);

      expect(res.status).toBe(302);
      const location = new URL(res.location!, BASE);
      expect(location.origin).toBe(BASE);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("client_id")).toBe(client.clientId);
      expect(location.searchParams.get("state")).toBe("it-state");
      expect(location.searchParams.get("sig")).toBeTruthy();
    });

    it("fetch からの呼び出し（Sec-Fetch-Mode: cors）には、302 の代わりに同じ行き先を JSON（redirect・url）で返す", async () => {
      const res = await http<{ redirect?: boolean; url?: string }>(`${AUTH}/oauth2/authorize?client_id=it-unknown-client`);

      expect(res.status).toBe(200);
      expect(res.json?.redirect).toBe(true);
      expect(new URL(res.json!.url!, BASE).pathname).toBe("/error");
    });
  });

  describe("異常系", () => {
    it("入力: 未登録の client_id は、渡した redirect_uri へは戻さず /error に invalid_client で送る", async () => {
      const query = new URLSearchParams({ response_type: "code", client_id: "it-unknown-client", redirect_uri: "https://evil.example/cb", scope: "openid", state: "x" });
      const res = await navigate(`${AUTH}/oauth2/authorize?${query}`);

      expect(res.status).toBe(302);
      const location = new URL(res.location!, BASE);
      expect(location.origin).toBe(BASE);
      expect(location.pathname).toBe("/error");
      expect(location.searchParams.get("error")).toBe("invalid_client");
    });

    it("入力: 登録済みのクライアントでも、登録外の redirect_uri には戻さず /error に invalid_redirect で送る", async (ctx) => {
      const client = await registeredClient();
      if (!client) return ctx.skip();

      const query = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: "https://evil.example/oauth2/idpresponse", scope: "openid", state: "x" });
      const res = await navigate(`${AUTH}/oauth2/authorize?${query}`);

      expect(res.status).toBe(302);
      const location = new URL(res.location!, BASE);
      expect(location.origin).toBe(BASE);
      expect(location.pathname).toBe("/error");
      expect(location.searchParams.get("error")).toBe("invalid_redirect");
    });

    it("空入力: パラメーターが無ければ /error に invalid_request で送る", async () => {
      const res = await navigate(`${AUTH}/oauth2/authorize`);

      expect(res.status).toBe(302);
      const location = new URL(res.location!, BASE);
      expect(location.pathname).toBe("/error");
      expect(location.searchParams.get("error")).toBe("invalid_request");
    });
  });
});

describe("POST /api/auth/oauth2/token", () => {
  describe("異常系", () => {
    it("入力: 未登録のクライアントの認証（client_secret_basic）は 401 invalid_client", async () => {
      const res = await tokenRequest({ grant_type: "client_credentials" }, { id: "it-unknown-client", secret: "it-wrong-secret-it-wrong-secret-00" });

      expect(res.status).toBe(401);
      expect(res.json?.error).toBe("invalid_client");
      expect(res.text).not.toContain("access_token");
    });

    it("入力: 登録済みのクライアントでもシークレットが違えば 401 invalid_client", async (ctx) => {
      const client = await registeredClient();
      if (!client) return ctx.skip();

      const res = await tokenRequest({ grant_type: "client_credentials" }, { id: client.clientId, secret: "it-wrong-secret-it-wrong-secret-00" });

      expect(res.status).toBe(401);
      expect(res.json?.error).toBe("invalid_client");
    });

    it("入力: 存在しない認可コードは 400 invalid_grant で、トークンを返さない", async () => {
      const res = await tokenRequest({ grant_type: "authorization_code", code: "it-not-a-code", redirect_uri: "https://evil.example/oauth2/idpresponse" }, { id: "it-unknown-client", secret: "it-wrong-secret-it-wrong-secret-00" });

      expect(res.status).toBe(400);
      expect(res.json?.error).toBe("invalid_grant");
      expect(res.text).not.toContain("access_token");
    });

    it("入力: 対応しない grant_type（password）は 400 unsupported_grant_type", async () => {
      const res = await tokenRequest({ grant_type: "password", username: "it-user", password: "it-password" });

      expect(res.status).toBe(400);
      expect(res.json?.error).toBe("unsupported_grant_type");
    });

    it("空入力: 本文が空なら 400 invalid_request", async () => {
      const res = await http<OAuthError>(`${AUTH}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });

      expect(res.status).toBe(400);
      expect(res.json?.error).toBe("invalid_request");
    });

    it("サーバ: PostgreSQL が応答しない間は 5xx かタイムアウトで、再開後は 401 invalid_client に戻る", async () => {
      const unknown = { id: "it-unknown-client", secret: "it-wrong-secret-it-wrong-secret-00" };
      const status = await withPaused(CONTAINERS.adminAuthPostgres, () => statusOrTimeout(tokenRequest({ grant_type: "client_credentials" }, unknown)));

      expect(status === "timeout" || status >= 500).toBe(true);
      await waitFor(async () => (await tokenRequest({ grant_type: "client_credentials" }, unknown)).status === 401, {
        timeoutMs: 30_000,
        what: "再開後にトークンエンドポイントが 401 を返す",
      });
    });
  });
});

describe("GET /api/auth/oauth2/userinfo", () => {
  describe("異常系", () => {
    it("空入力: Bearer が無ければ 401", async () => {
      const res = await http<OAuthError>(`${AUTH}/oauth2/userinfo`);

      expect(res.status).toBe(401);
      expect(res.json?.error).toBeTruthy();
    });

    it("入力: 不正なアクセストークンは 401 invalid_token で、WWW-Authenticate を返す", async () => {
      const res = await http<OAuthError>(`${AUTH}/oauth2/userinfo`, { headers: { authorization: "Bearer it-invalid-token" } });

      expect(res.status).toBe(401);
      expect(res.json?.error).toBe("invalid_token");
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(res.text).not.toContain("email");
    });
  });
});

describe("無効にしたログインの経路", () => {
  describe("異常系", () => {
    it("入力: JWT プラグインの素のトークン発行（/api/auth/token）は無効で 404", async () => {
      const res = await http(`${AUTH}/token`);

      expect(res.status).toBe(404);
    });

    it("入力: メールとパスワードのサインアップは無効で、ユーザーを作らない", async () => {
      const email = itEmail("admin-auth-signup");
      const res = await http<OAuthError>(`${AUTH}/sign-up/email`, {
        method: "POST",
        headers: { origin: BETTER_AUTH_URL },
        body: { email, password: "it-password-0123456789", name: "it-admin-auth" },
      });

      expect(res.status).toBe(400);
      expect(res.json?.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
      expect(await countUsersByEmail(email)).toBe(0);
    });

    it("入力: メールとパスワードのサインインも 4xx で、セッションの Cookie を返さない", async () => {
      const res = await http(`${AUTH}/sign-in/email`, {
        method: "POST",
        headers: { origin: BETTER_AUTH_URL },
        body: { email: itEmail("admin-auth-signin"), password: "it-password-0123456789" },
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(false);
    });
  });
});

describe("POST /api/auth/sign-in/social（Google。遷移はしない）", () => {
  describe("正常系", () => {
    it("Google の認可 URL を返し、hd・select_account・PKCE（S256）・admin-auth のコールバックが付く", async (ctx) => {
      if (!(await googleConfigured())) return ctx.skip(); // Google の資格情報が無い開発環境ではプロバイダーが無い

      const res = await startSocialSignIn({ provider: "google", callbackURL: "/" });

      expect(res.status).toBe(200);
      const url = new URL(res.json!.url!);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("hd")).toBe(HOSTED_DOMAIN);
      expect(url.searchParams.get("prompt")).toBe("select_account");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("redirect_uri")).toBe(`${BETTER_AUTH_URL}/api/auth/callback/google`);
      expect(url.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
      // state は HttpOnly の Cookie に署名つきで持つ（JS から読めない）
      expect(res.headers.getSetCookie().find((c) => c.includes("better-auth.state"))).toMatch(/HttpOnly/);
    });
  });

  describe("異常系", () => {
    it("入力: 別サイトの callbackURL は 403 INVALID_CALLBACK_URL で、認可 URL を返さない", async () => {
      const res = await startSocialSignIn({ provider: "google", callbackURL: "https://evil.example/after-login" });

      expect(res.status).toBe(403);
      expect(res.json?.code).toBe("INVALID_CALLBACK_URL");
      expect(res.json?.url).toBeUndefined();
    });

    it("入力: 設定していないプロバイダー（github）は 404", async () => {
      const res = await startSocialSignIn({ provider: "github", callbackURL: "/" });

      expect(res.status).toBe(404);
      expect(res.json?.url).toBeUndefined();
    });

    it("空入力: provider が無ければ 400", async () => {
      const res = await startSocialSignIn({});

      expect(res.status).toBe(400);
      expect(res.json?.url).toBeUndefined();
    });
  });
});
