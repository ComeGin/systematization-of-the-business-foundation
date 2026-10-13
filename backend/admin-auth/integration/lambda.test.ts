import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth.js";
import { parseAlbConfig, parseConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { type AlbEvent, type AlbResult, buildRuntime, createLambdaHandler } from "../src/lambda.js";
import { createOpsHandler } from "../src/ops.js";
import { IT_DATABASE, pausePostgres, postgresEnv, unpausePostgres } from "./helpers/postgres.js";

// ALB の形のイベントで本体（lambda.ts）と運用（ops.ts）を呼び、開発の PostgreSQL を本物として使う（仕様 7 節）。
// データベースは結合テスト専用（admin_auth_it。global-setup が毎回作り直して最後に消す）で、開発の admin_auth には触れない。
// Secrets Manager の代わりに設定を直接組み立てる。Google には触れない（DB に直接作ったセッションでログイン済みにする）
const RUN = randomBytes(4).toString("hex");
const EMAIL = `it-admin-${RUN}@comegin.com`;
const CLIENT_ID = `it-alb-${RUN}`;
const CLIENT_SECRET = `it-secret-${randomBytes(24).toString("hex")}`;
const AUTH_HOST = "auth.it.invalid";
const PROTECTED_HOST = "chat.it.invalid";
const REDIRECT_URI = `https://${PROTECTED_HOST}/oauth2/idpresponse`;

const env = {
  NODE_ENV: "development",
  BETTER_AUTH_URL: `https://${AUTH_HOST}`,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "5434",
  DATABASE_NAME: IT_DATABASE,
  DATABASE_USERNAME: postgresEnv("POSTGRES_USER"),
  DATABASE_PASSWORD: postgresEnv("POSTGRES_PASSWORD"),
  DATABASE_SSL: "false",
  GOOGLE_HOSTED_DOMAIN: "comegin.com",
  ADMIN_BOOTSTRAP_EMAILS: EMAIL,
  ALB_CLIENT_ID: CLIENT_ID,
  ALB_CLIENT_SECRET: CLIENT_SECRET,
  ALB_PROTECTED_HOSTS: PROTECTED_HOST,
};
const config = parseConfig(env, { requireGoogle: false });
const alb = parseAlbConfig(env);
const ops = createOpsHandler(async () => ({ config, alb }));
let direct: pg.Pool;
let clock = Date.now();
let builds = 0;
const lambda = createLambdaHandler({
  load: async () => config,
  build: (c: typeof config) => {
    builds += 1;
    return buildRuntime(c);
  },
  now: () => clock,
});

const event = (
  method: string,
  path: string,
  init: { query?: Record<string, string[]>; headers?: Record<string, string[]>; body?: string; base64?: boolean } = {},
): AlbEvent => ({
  httpMethod: method,
  path,
  multiValueQueryStringParameters: init.query ?? {},
  multiValueHeaders: { host: [AUTH_HOST], "x-forwarded-for": ["192.0.2.10"], ...init.headers },
  body: init.body ?? "",
  isBase64Encoded: init.base64 ?? false,
});
const header = (res: AlbResult, name: string) => res.multiValueHeaders[name]?.[0];

let userId: string | undefined;

/** Better Auth と同じ署名（better-call の signCookieValue: HMAC-SHA256 の base64 を . でつなぎ、URI エンコード）で、セッションの Cookie を作る。利用者は 1 回だけ作る */
async function sessionCookie(): Promise<string> {
  const pool = createPool(config);
  try {
    const ctx = await createAuth(config, pool).$context;
    userId ??= (await ctx.internalAdapter.createUser({ email: EMAIL, name: "IT admin", emailVerified: true })).id;
    const session = await ctx.internalAdapter.createSession(userId);
    const signature = createHmac("sha256", config.BETTER_AUTH_SECRET).update(session.token).digest("base64");
    return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
  } finally {
    await pool.end();
  }
}

beforeAll(() => {
  direct = new pg.Pool({ host: "127.0.0.1", port: 5434, database: env.DATABASE_NAME, user: env.DATABASE_USERNAME, password: env.DATABASE_PASSWORD, max: 1 });
});

afterEach(() => {
  unpausePostgres();
});

afterAll(async () => {
  await direct.end();
});

describe("運用の入口（ops.ts）", () => {
  describe("正常系", () => {
    it("migrate は 2 回目に表も列も作らず（冪等）、許可リストの初期値を入れる", async () => {
      await ops({ action: "migrate" });
      const second = await ops({ action: "migrate" });
      expect(second).toMatchObject({ ok: true, action: "migrate", result: { createdTables: [], addedColumnsTables: [] } });
      const rows = await direct.query(`SELECT added_by FROM admin_allowlist WHERE email = $1`, [EMAIL]);
      expect(rows.rows[0]?.added_by).toBe("bootstrap");
    });

    it("register-alb-client は created のあと unchanged", async () => {
      expect(await ops({ action: "register-alb-client" })).toMatchObject({ ok: true, result: { outcome: "created", redirectUris: [REDIRECT_URI] } });
      expect(await ops({ action: "register-alb-client" })).toMatchObject({ ok: true, result: { outcome: "unchanged" } });
    });
  });

  describe("異常系", () => {
    it("空入力: action が無ければ ok: false で、DB に触れない", async () => {
      expect(await ops({})).toMatchObject({ ok: false });
    });
  });
});

describe("本体（lambda.ts）: ALB と同じ流れ", () => {
  describe("正常系", () => {
    it("discovery と JWKS を返す", async () => {
      const discovery = await lambda(event("GET", "/.well-known/openid-configuration"));
      expect(discovery.statusCode).toBe(200);
      expect(JSON.parse(discovery.body).issuer).toBe(`https://${AUTH_HOST}/api/auth`);
      const jwks = await lambda(event("GET", "/api/auth/jwks"));
      expect(JSON.parse(jwks.body).keys[0].alg).toBe("RS256");
    });

    it("ログイン済みなら、認可 → コード → client_secret_basic のトークン → UserInfo が通る", async () => {
      const cookie = await sessionCookie();
      const authorize = await lambda(
        event("GET", "/api/auth/oauth2/authorize", {
          query: {
            response_type: ["code"],
            client_id: [CLIENT_ID],
            redirect_uri: [encodeURIComponent(REDIRECT_URI)],
            scope: ["openid%20email%20profile"],
            state: ["it-state"],
            nonce: ["it-nonce"],
          },
          headers: { cookie: [cookie], accept: ["text/html"], "sec-fetch-mode": ["navigate"], "sec-fetch-dest": ["document"] },
        }),
      );
      expect(authorize.statusCode).toBe(302);
      const location = new URL(header(authorize, "location")!);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
      expect(location.searchParams.get("state")).toBe("it-state");
      const code = location.searchParams.get("code")!;

      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString();
      const token = await lambda(
        event("POST", "/api/auth/oauth2/token", {
          headers: {
            "content-type": ["application/x-www-form-urlencoded"],
            authorization: [`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`],
          },
          body: Buffer.from(form).toString("base64"),
          base64: true,
        }),
      );
      expect(token.statusCode).toBe(200);
      const tokens = JSON.parse(token.body) as { access_token: string; id_token: string };
      expect(tokens.id_token).toBeTruthy();

      const userinfo = await lambda(event("GET", "/api/auth/oauth2/userinfo", { headers: { authorization: [`Bearer ${tokens.access_token}`] } }));
      expect(userinfo.statusCode).toBe(200);
      expect(JSON.parse(userinfo.body).email).toBe(EMAIL);
    });

    it("未ログインの認可は、署名つきのクエリを持って /sign-in へ送り、クエリを二重にエンコードしない", async () => {
      const res = await lambda(
        event("GET", "/api/auth/oauth2/authorize", {
          query: { response_type: ["code"], client_id: [CLIENT_ID], redirect_uri: [encodeURIComponent(REDIRECT_URI)], scope: ["openid"], state: ["s"] },
          headers: { accept: ["text/html"], "sec-fetch-mode": ["navigate"], "sec-fetch-dest": ["document"] },
        }),
      );
      expect(res.statusCode).toBe(302);
      const location = new URL(header(res, "location")!, `https://${AUTH_HOST}`);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    });

    it("ログアウトの複数の Set-Cookie を、つなげずに 1 つずつ返す（マルチバリューヘッダー）", async () => {
      const cookie = await sessionCookie();
      const res = await lambda(
        event("POST", "/api/auth/sign-out", {
          headers: { cookie: [cookie], origin: [`https://${AUTH_HOST}`], "content-type": ["application/json"] },
          body: "{}",
        }),
      );
      expect(res.statusCode).toBe(200);
      const setCookies = res.multiValueHeaders["set-cookie"] ?? [];
      expect(setCookies.length).toBeGreaterThanOrEqual(2);
      const names = setCookies.map((c) => c.split("=")[0]);
      expect(new Set(names).size).toBe(names.length);
      for (const c of setCookies) expect(c.match(/Max-Age=/gi)?.length).toBe(1);
    });

    it("60 秒以上空いたら作り直し（プールと auth）、そのあとも応答する", async () => {
      const before = builds;
      clock += 61_000;
      expect((await lambda(event("GET", "/api/auth/jwks"))).statusCode).toBe(200);
      expect(builds).toBe(before + 1);
    });
  });

  describe("異常系", () => {
    // authorization_code では Better Auth が認可コードを先に検査して 400 invalid_grant を返すため、
    // クライアントの認証だけを見る client_credentials で送る（直下の integration/tests/admin-auth と同じ）
    it("入力: シークレットが違えば 401 invalid_client", async () => {
      const form = new URLSearchParams({ grant_type: "client_credentials" }).toString();
      const res = await lambda(
        event("POST", "/api/auth/oauth2/token", {
          headers: { "content-type": ["application/x-www-form-urlencoded"], authorization: [`Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString("base64")}`] },
          body: Buffer.from(form).toString("base64"),
          base64: true,
        }),
      );
      expect(res.statusCode).toBe(401);
    });

    it("サーバ: PostgreSQL が止まると 5xx を返し（例外にしない）、再開後は 200 に戻る", async () => {
      pausePostgres();
      const failed = await lambda(event("GET", "/api/auth/jwks"));
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      unpausePostgres();
      await vi.waitFor(async () => expect((await lambda(event("GET", "/api/auth/jwks"))).statusCode).toBe(200), { timeout: 30_000, interval: 1_000 });
    });
  });
});
