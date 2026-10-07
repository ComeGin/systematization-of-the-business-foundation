import { beforeEach, describe, expect, it, vi } from "vitest";

// betterAuth に渡された設定のうち、テストで見る部分だけの型
type Hook<T> = (data: T) => Promise<{ data: T }>;
type CapturedOptions = {
  baseURL: string;
  trustedOrigins: string[];
  emailAndPassword: { enabled: boolean };
  socialProviders: {
    google?: {
      clientId: string;
      clientSecret: string;
      hd: string;
      mapProfileToUser: (profile: { hd?: string; email_verified?: boolean }) => unknown;
    };
  };
  rateLimit: { enabled: boolean; customRules: Record<string, { window: number; max: number }> };
  databaseHooks: {
    user: { create: { before: Hook<{ id: string; email?: string | null }> } };
    session: { create: { before: Hook<{ id: string; userId: string }> } };
  };
};

const mocks = vi.hoisted(() => {
  class FakeAPIError extends Error {
    status: string;
    constructor(status: string, body?: { message?: string }) {
      super(body?.message);
      this.name = "APIError";
      this.status = status;
    }
  }
  const getRow = vi.fn((_userId: string): { email?: string } | undefined => undefined);
  const prepare = vi.fn((_sql: string) => ({ get: getRow }));
  const runMigrations = vi.fn(async () => {});
  return {
    FakeAPIError,
    getRow,
    prepare,
    db: { prepare },
    runMigrations,
    getMigrations: vi.fn(async (_options: unknown) => ({ runMigrations })),
    betterAuth: vi.fn((options: unknown) => ({ options, api: {} })),
    openAuthDatabase: vi.fn((_dir: string): unknown => null),
    resolveDataDir: vi.fn(() => "/tmp/comegin-test-data"),
  };
});

vi.mock("better-auth", () => ({ betterAuth: mocks.betterAuth }));
vi.mock("better-auth/api", () => ({ APIError: mocks.FakeAPIError }));
vi.mock("better-auth/db/migration", () => ({ getMigrations: mocks.getMigrations }));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));
vi.mock("control-plane", () => ({
  openAuthDatabase: mocks.openAuthDatabase,
  resolveDataDir: mocks.resolveDataDir,
}));

import { ensureAuthSchema, getAuth, isAdminEmail, isGoogleConfigured } from "@/lib/auth";

const REFUSED = "このアカウントでは監視アプリにログインできません";

function captured(): CapturedOptions {
  getAuth();
  return mocks.betterAuth.mock.calls.at(-1)?.[0] as CapturedOptions;
}

function configureGoogle() {
  vi.stubEnv("GOOGLE_CLIENT_ID", " client-id ");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", " client-secret ");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.openAuthDatabase.mockReturnValue(mocks.db);
  globalThis.__comeginAuth = undefined;
  globalThis.__comeginAuthSchema = undefined;
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
  vi.stubEnv("GOOGLE_HOSTED_DOMAIN", "");
  vi.stubEnv("CONTROL_ADMIN_EMAILS", "admin@comegin.com");
});


describe("isGoogleConfigured", () => {
  describe("正常系", () => {
    it("クライアント ID とシークレットの両方があれば true", () => {
      configureGoogle();
      expect(isGoogleConfigured()).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each([
      ["ID だけ", "id", ""],
      ["シークレットだけ", "", "secret"],
    ])("入力: %s なら false", (_label, id, secret) => {
      vi.stubEnv("GOOGLE_CLIENT_ID", id);
      vi.stubEnv("GOOGLE_CLIENT_SECRET", secret);
      expect(isGoogleConfigured()).toBe(false);
    });

    it.each([
      ["空白だけ", "  ", "  "],
      ["未設定", undefined, undefined],
    ])("空入力: %s なら false", (_label, id, secret) => {
      vi.stubEnv("GOOGLE_CLIENT_ID", id);
      vi.stubEnv("GOOGLE_CLIENT_SECRET", secret);
      expect(isGoogleConfigured()).toBe(false);
    });
  });
});

describe("isAdminEmail（要求ごとの許可リストの検査）", () => {
  describe("正常系", () => {
    it("Workspace のドメインで許可リストにあるメールなら true（大文字・前後の空白は区別しない）", () => {
      vi.stubEnv("CONTROL_ADMIN_EMAILS", " other@comegin.com , Admin@Comegin.com ");
      expect(isAdminEmail("ADMIN@comegin.com")).toBe(true);
      expect(isAdminEmail("other@comegin.com")).toBe(true);
    });

    it("GOOGLE_HOSTED_DOMAIN を設定すれば、そのドメインで判定する", () => {
      vi.stubEnv("GOOGLE_HOSTED_DOMAIN", "example.co.jp");
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "admin@example.co.jp,admin@comegin.com");
      expect(isAdminEmail("admin@example.co.jp")).toBe(true);
      expect(isAdminEmail("admin@comegin.com")).toBe(false);
    });

    it("許可リストは呼び出しのたびに読み直す（外したメールは次の判定から false）", () => {
      expect(isAdminEmail("admin@comegin.com")).toBe(true);
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "someone-else@comegin.com");
      expect(isAdminEmail("admin@comegin.com")).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 許可リストに無いメールなら false", () => {
      expect(isAdminEmail("outsider@comegin.com")).toBe(false);
    });

    it("入力: 許可リストにあっても Workspace のドメインの外なら false", () => {
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "admin@example.com");
      expect(isAdminEmail("admin@example.com")).toBe(false);
    });

    it("入力: ドメインの後ろに別のドメインを続けて装ったメールは false", () => {
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "admin@comegin.com.evil.example");
      expect(isAdminEmail("admin@comegin.com.evil.example")).toBe(false);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["空文字", ""],
    ])("空入力: メールが %s なら false", (_label, email) => {
      expect(isAdminEmail(email)).toBe(false);
    });

    it("空入力: 許可リストが空なら、だれでも false", () => {
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "");
      expect(isAdminEmail("admin@comegin.com")).toBe(false);
    });
  });
});

describe("getAuth", () => {
  describe("正常系", () => {
    it("インスタンスはプロセスで 1 つだけ作り、DB は CONTROL_DATA_DIR の解決結果で開く", () => {
      expect(getAuth()).toBe(getAuth());
      expect(mocks.betterAuth).toHaveBeenCalledTimes(1);
      expect(mocks.openAuthDatabase).toHaveBeenCalledWith("/tmp/comegin-test-data");
    });

    it("メールとパスワードのログインは持たない", () => {
      expect(captured().emailAndPassword.enabled).toBe(false);
    });

    it("Google の資格情報は前後の空白を除いて渡し、hd は既定で comegin.com にする", () => {
      configureGoogle();
      const google = captured().socialProviders.google;
      expect(google).toMatchObject({ clientId: "client-id", clientSecret: "client-secret", hd: "comegin.com" });
    });

    it("GOOGLE_HOSTED_DOMAIN を設定すれば hd はその値になる", () => {
      configureGoogle();
      vi.stubEnv("GOOGLE_HOSTED_DOMAIN", "example.co.jp");
      expect(captured().socialProviders.google?.hd).toBe("example.co.jp");
    });

    it("空入力: BETTER_AUTH_URL が無ければ 127.0.0.1:3200 にし、localhost も同じオリジンとして信頼する", () => {
      const options = captured();
      expect(options.baseURL).toBe("http://127.0.0.1:3200");
      expect(options.trustedOrigins).toEqual(["http://127.0.0.1:3200", "http://localhost:3200"]);
    });

    it("空入力: GOOGLE_HOSTED_DOMAIN が空白だけなら hd は既定の comegin.com にする", () => {
      configureGoogle();
      vi.stubEnv("GOOGLE_HOSTED_DOMAIN", "   ");
      expect(captured().socialProviders.google?.hd).toBe("comegin.com");
    });

    it("ngrok の URL のときは、その URL だけを信頼する", () => {
      vi.stubEnv("BETTER_AUTH_URL", "https://comegin-next-js-dev.ngrok.app");
      const options = captured();
      expect(options.baseURL).toBe("https://comegin-next-js-dev.ngrok.app");
      expect(new Set(options.trustedOrigins)).toEqual(new Set(["https://comegin-next-js-dev.ngrok.app"]));
    });

    it("ngrok で外に出すため、開発でも回数の制限を有効にし、Google のログイン開始はより厳しくする", () => {
      const { rateLimit } = captured();
      expect(rateLimit.enabled).toBe(true);
      expect(rateLimit.customRules["/sign-in/social"]?.max).toBeLessThan(100);
    });
  });

  describe("異常系", () => {
    it("空入力: Google の資格情報が無ければソーシャルログインを登録しない（だれもログインできない）", () => {
      expect(captured().socialProviders).toEqual({});
    });

    it("サーバ: ログイン用 DB を開けなければ例外を返し、壊れたインスタンスを覚えない（次の呼び出しで作り直す）", () => {
      mocks.openAuthDatabase.mockImplementationOnce(() => {
        throw new Error("SQLITE_CANTOPEN");
      });
      expect(() => getAuth()).toThrow("SQLITE_CANTOPEN");
      expect(globalThis.__comeginAuth).toBeUndefined();
      expect(getAuth()).toBeDefined();
      expect(mocks.openAuthDatabase).toHaveBeenCalledTimes(2);
    });
  });
});

describe("mapProfileToUser（Google の profile の検査）", () => {
  beforeEach(() => {
    configureGoogle();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("正常系", () => {
    it("hd が Workspace のドメインで email_verified が true なら通す", () => {
      const google = captured().socialProviders.google!;
      expect(google.mapProfileToUser({ hd: "comegin.com", email_verified: true })).toEqual({});
    });
  });

  describe("異常系", () => {
    it.each([
      ["hd が無い（個人の Google アカウント）", { email_verified: true }],
      ["hd が別のドメイン", { hd: "evil.example.com", email_verified: true }],
      ["hd の大文字小文字が違う", { hd: "COMEGIN.COM", email_verified: true }],
      ["email_verified が false", { hd: "comegin.com", email_verified: false }],
      ["email_verified が無い", { hd: "comegin.com" }],
    ])("入力: %s なら FORBIDDEN で拒否する", (_label, profile) => {
      const google = captured().socialProviders.google!;
      expect(() => google.mapProfileToUser(profile)).toThrow(expect.objectContaining({ status: "FORBIDDEN", message: REFUSED }));
    });

    it("空入力: profile が空のオブジェクトなら FORBIDDEN で拒否する", () => {
      const google = captured().socialProviders.google!;
      expect(() => google.mapProfileToUser({})).toThrow(expect.objectContaining({ status: "FORBIDDEN", message: REFUSED }));
    });
  });
});

describe("databaseHooks.user.create（ユーザーの作成）", () => {
  const user = (email: string | null | undefined) => ({ id: "u1", email });

  describe("正常系", () => {
    it("Workspace のドメインで許可リストにあるメールなら作成を許す", async () => {
      const before = captured().databaseHooks.user.create.before;
      await expect(before(user("admin@comegin.com"))).resolves.toEqual({ data: user("admin@comegin.com") });
    });

    it("許可リストとの比較は大文字小文字と前後の空白を無視する", async () => {
      vi.stubEnv("CONTROL_ADMIN_EMAILS", " other@comegin.com , Admin@Comegin.com ");
      const before = captured().databaseHooks.user.create.before;
      await expect(before(user("ADMIN@comegin.COM"))).resolves.toBeDefined();
    });
  });

  describe("異常系", () => {
    it.each([
      ["ドメインが違う", "admin@gmail.com", "outside the workspace domain"],
      ["ドメインの末尾を装う", "admin@evilcomegin.com", "outside the workspace domain"],
      ["サブドメインを装う", "admin@comegin.com.evil.com", "outside the workspace domain"],
      ["許可リストにない", "intern@comegin.com", "not on the allowlist"],
    ])("入力: %s なら拒否し、ログには理由の種類だけを残す（メールは残さない）", async (_label, email, reason) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const before = captured().databaseHooks.user.create.before;
      await expect(before(user(email))).rejects.toMatchObject({ status: "FORBIDDEN", message: REFUSED });
      const logged = consoleError.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain(reason);
      expect(logged).not.toContain(email);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["空文字", ""],
    ])("空入力: メールが %s なら拒否し、ログには理由の種類（no email）だけを残す", async (_label, email) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const before = captured().databaseHooks.user.create.before;
      await expect(before(user(email))).rejects.toMatchObject({ status: "FORBIDDEN", message: REFUSED });
      expect(consoleError.mock.calls.map((args) => args.join(" ")).join("\n")).toContain("no email");
    });

    it.each([
      ["空", ""],
      ["カンマと空白だけ", " , ,"],
    ])("空入力: 許可リストが%sならだれも通さない", async (_label, list) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("CONTROL_ADMIN_EMAILS", list);
      const before = captured().databaseHooks.user.create.before;
      await expect(before(user("admin@comegin.com"))).rejects.toMatchObject({ status: "FORBIDDEN" });
    });

    it("入力: 許可リストは判定のたびに読む（インスタンスを作った後に外した人も通さない）", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const before = captured().databaseHooks.user.create.before;
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "someone-else@comegin.com");
      await expect(before(user("admin@comegin.com"))).rejects.toMatchObject({ status: "FORBIDDEN" });
    });
  });
});

describe("databaseHooks.session.create（セッションの作成）", () => {
  const session = { id: "s1", userId: "u1" };

  describe("正常系", () => {
    it("DB のユーザーの行からメールを引き、許可リストにあればセッションを作る", async () => {
      mocks.getRow.mockReturnValue({ email: "admin@comegin.com" });
      const before = captured().databaseHooks.session.create.before;
      await expect(before(session)).resolves.toEqual({ data: session });
      expect(mocks.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM "user" WHERE id = ?'));
      expect(mocks.getRow).toHaveBeenCalledWith("u1");
    });
  });

  describe("異常系", () => {
    it("入力: 既存のユーザーでも、許可リストから外されていればセッションを作らない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.getRow.mockReturnValue({ email: "admin@comegin.com" });
      vi.stubEnv("CONTROL_ADMIN_EMAILS", "");
      const before = captured().databaseHooks.session.create.before;
      await expect(before(session)).rejects.toMatchObject({ status: "FORBIDDEN" });
    });

    it("空入力: ユーザーの行が見つからなければセッションを作らない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.getRow.mockReturnValue(undefined);
      const before = captured().databaseHooks.session.create.before;
      await expect(before(session)).rejects.toMatchObject({ status: "FORBIDDEN" });
    });

    it("空入力: ユーザーの行にメールが無ければセッションを作らない", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.getRow.mockReturnValue({});
      const before = captured().databaseHooks.session.create.before;
      await expect(before(session)).rejects.toMatchObject({ status: "FORBIDDEN" });
    });

    it("サーバ: ユーザーの行の読み出しで DB が例外を投げたら、セッションを作らない（例外を返す）", async () => {
      mocks.getRow.mockImplementation(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });
      const before = captured().databaseHooks.session.create.before;
      await expect(before(session)).rejects.toThrow("SQLITE_BUSY");
    });
  });
});

describe("ensureAuthSchema", () => {
  describe("正常系", () => {
    it("Better Auth の設定でマイグレーションを 1 回だけ行う", async () => {
      await Promise.all([ensureAuthSchema(), ensureAuthSchema()]);
      await ensureAuthSchema();
      expect(mocks.getMigrations).toHaveBeenCalledTimes(1);
      expect(mocks.getMigrations).toHaveBeenCalledWith(captured());
      expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
    });

    it("空入力: 適用するマイグレーションが無くても（runMigrations が何もしない）解決する", async () => {
      await expect(ensureAuthSchema()).resolves.toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("サーバ: マイグレーションに失敗したら例外を返し、次の呼び出しで再試行する", async () => {
      mocks.runMigrations.mockRejectedValueOnce(new Error("disk full"));
      await expect(ensureAuthSchema()).rejects.toThrow("disk full");
      await expect(ensureAuthSchema()).resolves.toBeUndefined();
      expect(mocks.runMigrations).toHaveBeenCalledTimes(2);
    });

    it("サーバ: マイグレーションの計画（getMigrations）に失敗しても、次の呼び出しで再試行する", async () => {
      mocks.getMigrations.mockRejectedValueOnce(new Error("SQLITE_READONLY"));
      await expect(ensureAuthSchema()).rejects.toThrow("SQLITE_READONLY");
      await expect(ensureAuthSchema()).resolves.toBeUndefined();
      expect(mocks.getMigrations).toHaveBeenCalledTimes(2);
    });
  });
});
