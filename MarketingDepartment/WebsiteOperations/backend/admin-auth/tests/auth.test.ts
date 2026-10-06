import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { captureStderr, validEnv } from "./helpers/env.js";
import { fakePool } from "./helpers/pool.js";

const mocks = vi.hoisted(() => ({
  jwt: vi.fn((options: unknown) => ({ id: "jwt", options })),
  oauthProvider: vi.fn((options: unknown) => ({ id: "oauth-provider", options })),
  betterAuth: vi.fn((options: unknown) => ({ options })),
}));
vi.mock("better-auth/plugins", () => ({ jwt: mocks.jwt }));
vi.mock("@better-auth/oauth-provider", () => ({ oauthProvider: mocks.oauthProvider }));
vi.mock("better-auth", () => ({ betterAuth: mocks.betterAuth }));

const { createAuth, createAuthOptions } = await import("../src/auth.js");

const withGoogle = () =>
  loadConfig(validEnv({ GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "google-secret" }));

/** 許可リストの表と user 表の代わり */
function poolWith({ allowlisted = [] as string[], users = {} as Record<string, string> } = {}) {
  return fakePool((sql, params) => {
    if (sql.includes("admin_allowlist")) return { rowCount: allowlisted.includes(String(params?.[0])) ? 1 : 0 };
    if (sql.includes(`FROM "user"`)) {
      const email = users[String(params?.[0])];
      return { rows: email ? [{ email }] : [] };
    }
    return {};
  });
}

async function expectForbidden(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("拒否されなかった");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(APIError);
  expect((error as APIError).statusCode).toBe(403);
  return error as APIError;
}

beforeEach(() => {
  mocks.jwt.mockClear();
  mocks.oauthProvider.mockClear();
  mocks.betterAuth.mockClear();
});

describe("createAuthOptions の基本設定", () => {
  it("issuer の土台（baseURL・basePath）と信頼するオリジンを BETTER_AUTH_URL にそろえる", () => {
    const options = createAuthOptions(loadConfig(validEnv({ BETTER_AUTH_URL: "https://auth.comegin.com/x" })), fakePool().pool);
    expect(options.baseURL).toBe("https://auth.comegin.com");
    expect(options.basePath).toBe("/api/auth");
    expect(options.trustedOrigins).toEqual(["https://auth.comegin.com"]);
  });

  it("OAuth Provider と併用するため /token を無効にする", () => {
    expect(createAuthOptions(withGoogle(), fakePool().pool).disabledPaths).toContain("/token");
  });

  it("セッションは ALB とそろえて 12 時間、更新は 1 時間ごと", () => {
    expect(createAuthOptions(withGoogle(), fakePool().pool).session).toEqual({ expiresIn: 43_200, updateAge: 3_600 });
  });

  it("Google のトークンを DB に暗号化して置き、失敗時は自前の /error へ送る", () => {
    const options = createAuthOptions(withGoogle(), fakePool().pool);
    expect(options.account).toEqual({ encryptOAuthTokens: true });
    expect(options.onAPIError).toEqual({ errorURL: "/error" });
  });

  it("ソーシャルログインの開始に、全体より厳しいレート制限をかける", () => {
    const { rateLimit } = createAuthOptions(withGoogle(), fakePool().pool);
    expect(rateLimit.enabled).toBe(true);
    expect(rateLimit.customRules["/sign-in/social"].max).toBeLessThan(rateLimit.max);
  });

  it("送信元 IP は X-Forwarded-For から取る", () => {
    expect(createAuthOptions(withGoogle(), fakePool().pool).advanced.ipAddress.ipAddressHeaders).toEqual(["x-forwarded-for"]);
  });

  it("メールとパスワードのログインを有効にしない", () => {
    expect(createAuthOptions(withGoogle(), fakePool().pool)).not.toHaveProperty("emailAndPassword");
  });
});

describe("プラグインの設定", () => {
  it("jwt は set-auth-jwt ヘッダーを無効にし、署名の鍵を RS256 にする", () => {
    createAuthOptions(withGoogle(), fakePool().pool);
    expect(mocks.jwt).toHaveBeenCalledWith({ disableSettingJwtHeader: true, jwks: { keyPairConfig: { alg: "RS256" } } });
  });

  it("oauthProvider は内蔵のログイン・同意画面を使い、scope は openid profile email、シークレットはハッシュで保存する", () => {
    createAuthOptions(withGoogle(), fakePool().pool);
    expect(mocks.oauthProvider).toHaveBeenCalledWith({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "profile", "email"],
      storeClientSecret: "hashed",
    });
  });

  it("プラグインは jwt・oauthProvider の 2 つだけ", () => {
    const { plugins } = createAuthOptions(withGoogle(), fakePool().pool);
    expect(plugins.map((plugin) => (plugin as { id: string }).id)).toEqual(["jwt", "oauth-provider"]);
  });
});

describe("Google プロバイダー", () => {
  it("ID とシークレットがあれば、hd を Workspace のドメインにし、アカウントを毎回選ばせる", () => {
    const google = createAuthOptions(withGoogle(), fakePool().pool).socialProviders.google;
    expect(google).toMatchObject({
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "google-secret",
      hd: "comegin.com",
      prompt: "select_account",
    });
  });

  it("GOOGLE_HOSTED_DOMAIN を変えれば hd も変わる", () => {
    const config = loadConfig(
      validEnv({ GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: "example.co.jp" }),
    );
    expect(createAuthOptions(config, fakePool().pool).socialProviders.google?.hd).toBe("example.co.jp");
  });

  it("ID かシークレットが欠けていれば Google を登録しない", () => {
    const config = loadConfig(validEnv({ GOOGLE_CLIENT_ID: "c" }));
    expect(createAuthOptions(config, fakePool().pool).socialProviders).toEqual({});
  });

  describe("mapProfileToUser（2 段目の検査）", () => {
    const map = () => createAuthOptions(withGoogle(), fakePool().pool).socialProviders.google!.mapProfileToUser;

    it("hd が一致し email_verified が true なら、上書きする項目なしで通す", () => {
      expect(map()({ hd: "comegin.com", email_verified: true })).toEqual({});
    });

    it("hd が違えば拒否する", () => {
      captureStderr();
      expect(() => map()({ hd: "evil.com", email_verified: true })).toThrow(APIError);
    });

    it("hd が無ければ拒否する（Workspace に外部のメールで作られたアカウント）", () => {
      captureStderr();
      expect(() => map()({ email_verified: true })).toThrow(APIError);
    });

    it("hd のサブドメインは一致とみなさない", () => {
      captureStderr();
      expect(() => map()({ hd: "sub.comegin.com", email_verified: true })).toThrow(APIError);
    });

    it("email_verified が true でなければ拒否する", () => {
      captureStderr();
      expect(() => map()({ hd: "comegin.com", email_verified: false })).toThrow(APIError);
      expect(() => map()({ hd: "comegin.com" })).toThrow(APIError);
    });

    it("拒否の理由の種類だけを記録する", () => {
      const stderr = captureStderr();
      expect(() => map()({ hd: "evil.com", email_verified: true })).toThrow();
      expect(stderr.text()).toBe("[auth] login refused: hd claim does not match");
    });
  });
});

describe("databaseHooks.user.create.before（3 段目: ユーザーの作成）", () => {
  const hook = (pool = poolWith({ allowlisted: ["admin@comegin.com"] }).pool) =>
    createAuthOptions(withGoogle(), pool).databaseHooks.user.create.before;

  it("Workspace のドメインで、許可リストにあるメールだけを通す", async () => {
    await expect(hook()({ email: "admin@comegin.com" })).resolves.toBeUndefined();
  });

  it("大文字を含むメールも、許可リストの小文字の行と照合して通す", async () => {
    await expect(hook()({ email: "Admin@Comegin.COM" })).resolves.toBeUndefined();
  });

  it("許可リストに無いメールは拒否し、メッセージは固定の文言にする", async () => {
    captureStderr();
    const error = await expectForbidden(hook()({ email: "other@comegin.com" }));
    expect(error.message).toBe("このアカウントでは管理画面にログインできません");
  });

  it("ドメイン外のメールは、許可リストを引く前に拒否する", async () => {
    captureStderr();
    const { pool, query } = poolWith({ allowlisted: ["admin@evil.com"] });
    await expectForbidden(hook(pool)({ email: "admin@evil.com" }));
    expect(query).not.toHaveBeenCalled();
  });

  it("ドメインを末尾に含むだけの別ドメイン（evilcomegin.com）を拒否する", async () => {
    captureStderr();
    await expectForbidden(hook(poolWith({ allowlisted: ["admin@evilcomegin.com"] }).pool)({ email: "admin@evilcomegin.com" }));
  });

  it("サブドメインのメール（@sub.comegin.com）を拒否する", async () => {
    captureStderr();
    await expectForbidden(hook(poolWith({ allowlisted: ["a@sub.comegin.com"] }).pool)({ email: "a@sub.comegin.com" }));
  });

  it("メールが無い・空・null なら拒否する", async () => {
    captureStderr();
    await expectForbidden(hook()({}));
    await expectForbidden(hook()({ email: "" }));
    await expectForbidden(hook()({ email: null }));
  });

  it("拒否したときにメールアドレスを記録しない", async () => {
    const stderr = captureStderr();
    await expectForbidden(hook()({ email: "secret.person@comegin.com" }));
    expect(stderr.text()).toBe("[auth] login refused: email is not on the allowlist");
    expect(stderr.text()).not.toContain("secret.person");
  });
});

describe("databaseHooks.session.create.before（3 段目: セッションの作成）", () => {
  it("DB の user の行のメールが許可リストにあれば通す", async () => {
    const { pool, query } = poolWith({ allowlisted: ["admin@comegin.com"], users: { u1: "admin@comegin.com" } });
    const hook = createAuthOptions(withGoogle(), pool).databaseHooks.session.create.before;
    await expect(hook({ userId: "u1" })).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[1]).toEqual(["u1"]);
  });

  it("許可リストから外されたユーザーは、既存のユーザーでも新しいセッションを作れない", async () => {
    captureStderr();
    const { pool } = poolWith({ allowlisted: [], users: { u1: "admin@comegin.com" } });
    await expectForbidden(createAuthOptions(withGoogle(), pool).databaseHooks.session.create.before({ userId: "u1" }));
  });

  it("user の行が無ければ拒否する", async () => {
    captureStderr();
    const { pool } = poolWith({ allowlisted: ["admin@comegin.com"] });
    await expectForbidden(createAuthOptions(withGoogle(), pool).databaseHooks.session.create.before({ userId: "missing" }));
  });

  it("DB のエラーは握りつぶさず、そのまま失敗させる", async () => {
    const pool = { query: vi.fn(async () => Promise.reject(new Error("db down"))) } as never;
    await expect(createAuthOptions(withGoogle(), pool).databaseHooks.session.create.before({ userId: "u1" })).rejects.toThrow(
      "db down",
    );
  });
});

describe("createAuth", () => {
  it("createAuthOptions の内容で betterAuth を作る", () => {
    const { pool } = fakePool();
    createAuth(withGoogle(), pool);
    const options = mocks.betterAuth.mock.calls[0]?.[0] as { database: unknown; basePath: string };
    expect(options.database).toBe(pool);
    expect(options.basePath).toBe("/api/auth");
  });
});
