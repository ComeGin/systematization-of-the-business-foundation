import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { captureStderr, validEnv } from "./helpers/env.js";
import { fakePool } from "./helpers/pool.js";

// better-auth・プラグイン・APIError はすべて偽物に差し替える（ライブラリ本体は読み込まない）。
// APIError の偽物は、src が渡したステータス名（"FORBIDDEN"）と本文をそのまま持つだけ
const mocks = vi.hoisted(() => {
  class APIError extends Error {
    constructor(
      public status: string,
      public body: { message?: string } = {},
    ) {
      super(body.message);
    }
  }
  return {
    APIError,
    jwt: vi.fn((options: unknown) => ({ id: "jwt", options })),
    oauthProvider: vi.fn((options: unknown) => ({ id: "oauth-provider", options })),
    betterAuth: vi.fn((options: unknown) => ({ options })),
  };
});
vi.mock("better-auth/api", () => ({ APIError: mocks.APIError }));
vi.mock("better-auth/plugins", () => ({ jwt: mocks.jwt }));
vi.mock("@better-auth/oauth-provider", () => ({ oauthProvider: mocks.oauthProvider }));
vi.mock("better-auth", () => ({ betterAuth: mocks.betterAuth }));

const { createAuth, createAuthOptions } = await import("../src/auth.js");
const { APIError } = mocks;
type APIError = InstanceType<typeof APIError>;

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

/** query が RDS 側の例外で失敗する pg.Pool の代わり */
function failingPool(message: string) {
  return fakePool(() => {
    throw new Error(message);
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
  expect((error as APIError).status).toBe("FORBIDDEN");
  return error as APIError;
}

beforeEach(() => {
  mocks.jwt.mockClear();
  mocks.oauthProvider.mockClear();
  mocks.betterAuth.mockClear();
});

describe("createAuthOptions の基本設定", () => {
  describe("正常系", () => {
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

    it("設定を作るだけでは DB に問い合わせない", () => {
      const { pool, query } = fakePool();
      createAuthOptions(withGoogle(), pool);
      expect(query).not.toHaveBeenCalled();
    });
  });
});

describe("プラグインの設定", () => {
  describe("正常系", () => {
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
});

describe("Google プロバイダー", () => {
  describe("正常系", () => {
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

    it("空入力: ID かシークレットが欠けていれば Google を登録しない", () => {
      const config = loadConfig(validEnv({ GOOGLE_CLIENT_ID: "c" }));
      expect(createAuthOptions(config, fakePool().pool).socialProviders).toEqual({});
    });

    it("空入力: ID とシークレットが両方とも空文字なら Google を登録しない", () => {
      const config = loadConfig(validEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }));
      expect(createAuthOptions(config, fakePool().pool).socialProviders).toEqual({});
    });
  });
});

describe("mapProfileToUser（2 段目の検査）", () => {
  const map = () => createAuthOptions(withGoogle(), fakePool().pool).socialProviders.google!.mapProfileToUser;

  describe("正常系", () => {
    it("hd が一致し email_verified が true なら、上書きする項目なしで通す", () => {
      expect(map()({ hd: "comegin.com", email_verified: true })).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: hd が違えば拒否する", () => {
      captureStderr();
      expect(() => map()({ hd: "evil.com", email_verified: true })).toThrow(APIError);
    });

    it("入力: hd が無ければ拒否する（Workspace に外部のメールで作られたアカウント）", () => {
      captureStderr();
      expect(() => map()({ email_verified: true })).toThrow(APIError);
    });

    it("入力: hd のサブドメインは一致とみなさない", () => {
      captureStderr();
      expect(() => map()({ hd: "sub.comegin.com", email_verified: true })).toThrow(APIError);
    });

    it("入力: email_verified が true でなければ拒否する", () => {
      captureStderr();
      expect(() => map()({ hd: "comegin.com", email_verified: false })).toThrow(APIError);
      expect(() => map()({ hd: "comegin.com" })).toThrow(APIError);
    });

    it("空入力: profile が空のオブジェクトなら拒否する", () => {
      captureStderr();
      expect(() => map()({})).toThrow(APIError);
    });

    it("入力: 拒否の理由の種類だけを記録し、FORBIDDEN と固定の文言で返す", () => {
      const stderr = captureStderr();
      let caught: unknown;
      try {
        map()({ hd: "evil.com", email_verified: true });
      } catch (error) {
        caught = error;
      }
      expect(stderr.text()).toBe("[auth] login refused: hd claim does not match");
      expect((caught as APIError).status).toBe("FORBIDDEN");
      expect((caught as APIError).message).toBe("このアカウントでは管理画面にログインできません");
    });
  });
});

describe("databaseHooks.user.create.before（3 段目: ユーザーの作成）", () => {
  const hook = (pool = poolWith({ allowlisted: ["admin@comegin.com"] }).pool) =>
    createAuthOptions(withGoogle(), pool).databaseHooks.user.create.before;

  describe("正常系", () => {
    it("Workspace のドメインで、許可リストにあるメールだけを通す", async () => {
      await expect(hook()({ email: "admin@comegin.com" })).resolves.toBeUndefined();
    });

    it("大文字を含むメールも、許可リストの小文字の行と照合して通す", async () => {
      await expect(hook()({ email: "Admin@Comegin.COM" })).resolves.toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("入力: 許可リストに無いメールは拒否し、メッセージは固定の文言にする", async () => {
      captureStderr();
      const error = await expectForbidden(hook()({ email: "other@comegin.com" }));
      expect(error.message).toBe("このアカウントでは管理画面にログインできません");
    });

    it("入力: ドメイン外のメールは、許可リストを引く前に拒否する", async () => {
      captureStderr();
      const { pool, query } = poolWith({ allowlisted: ["admin@evil.com"] });
      await expectForbidden(hook(pool)({ email: "admin@evil.com" }));
      expect(query).not.toHaveBeenCalled();
    });

    it("入力: ドメインを末尾に含むだけの別ドメイン（evilcomegin.com）を拒否する", async () => {
      captureStderr();
      await expectForbidden(hook(poolWith({ allowlisted: ["admin@evilcomegin.com"] }).pool)({ email: "admin@evilcomegin.com" }));
    });

    it("入力: サブドメインのメール（@sub.comegin.com）を拒否する", async () => {
      captureStderr();
      await expectForbidden(hook(poolWith({ allowlisted: ["a@sub.comegin.com"] }).pool)({ email: "a@sub.comegin.com" }));
    });

    it("空入力: メールが無い・空・null なら、DB を引かずに拒否する", async () => {
      captureStderr();
      const { pool, query } = poolWith({ allowlisted: ["admin@comegin.com"] });
      await expectForbidden(hook(pool)({}));
      await expectForbidden(hook(pool)({ email: "" }));
      await expectForbidden(hook(pool)({ email: null }));
      expect(query).not.toHaveBeenCalled();
    });

    it("入力: 拒否したときにメールアドレスを記録しない", async () => {
      const stderr = captureStderr();
      await expectForbidden(hook()({ email: "secret.person@comegin.com" }));
      expect(stderr.text()).toBe("[auth] login refused: email is not on the allowlist");
      expect(stderr.text()).not.toContain("secret.person");
    });

    it("サーバ: 許可リストを引く DB のエラーは握りつぶさず（通さず）、そのまま失敗させる", async () => {
      const { pool } = failingPool("Connection terminated unexpectedly");
      await expect(hook(pool)({ email: "admin@comegin.com" })).rejects.toThrow("Connection terminated unexpectedly");
    });
  });
});

describe("databaseHooks.session.create.before（3 段目: セッションの作成）", () => {
  const hook = (pool: ReturnType<typeof fakePool>["pool"]) =>
    createAuthOptions(withGoogle(), pool).databaseHooks.session.create.before;

  describe("正常系", () => {
    it("DB の user の行のメールが許可リストにあれば通す", async () => {
      const { pool, query } = poolWith({ allowlisted: ["admin@comegin.com"], users: { u1: "admin@comegin.com" } });
      await expect(hook(pool)({ userId: "u1" })).resolves.toBeUndefined();
      expect(query.mock.calls[0]?.[1]).toEqual(["u1"]);
    });
  });

  describe("異常系", () => {
    it("入力: 許可リストから外されたユーザーは、既存のユーザーでも新しいセッションを作れない", async () => {
      captureStderr();
      const { pool } = poolWith({ allowlisted: [], users: { u1: "admin@comegin.com" } });
      await expectForbidden(hook(pool)({ userId: "u1" }));
    });

    it("空入力: user の行が無ければ（0 件の応答）拒否する", async () => {
      const stderr = captureStderr();
      const { pool } = poolWith({ allowlisted: ["admin@comegin.com"] });
      await expectForbidden(hook(pool)({ userId: "missing" }));
      expect(stderr.text()).toBe("[auth] login refused: no email");
    });

    it("空入力: userId が空文字なら、user の行が見つからず拒否する", async () => {
      captureStderr();
      const { pool } = poolWith({ allowlisted: ["admin@comegin.com"], users: { u1: "admin@comegin.com" } });
      await expectForbidden(hook(pool)({ userId: "" }));
    });

    it("サーバ: DB のエラーは握りつぶさず、そのまま失敗させる", async () => {
      const { pool } = failingPool("db down");
      await expect(hook(pool)({ userId: "u1" })).rejects.toThrow("db down");
    });
  });
});

describe("createAuth", () => {
  describe("正常系", () => {
    it("createAuthOptions の内容で betterAuth を作る", () => {
      const { pool } = fakePool();
      createAuth(withGoogle(), pool);
      const options = mocks.betterAuth.mock.calls[0]?.[0] as { database: unknown; basePath: string };
      expect(options.database).toBe(pool);
      expect(options.basePath).toBe("/api/auth");
    });

    it("空入力: Google の ID とシークレットが未設定でも作れる（開発）", () => {
      createAuth(loadConfig(validEnv()), fakePool().pool);
      const options = mocks.betterAuth.mock.calls[0]?.[0] as { socialProviders: unknown };
      expect(options.socialProviders).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: betterAuth が設定を拒否して投げた例外は、そのまま投げる", () => {
      mocks.betterAuth.mockImplementationOnce(() => {
        throw new Error("invalid options");
      });
      expect(() => createAuth(withGoogle(), fakePool().pool)).toThrow("invalid options");
    });
  });
});
