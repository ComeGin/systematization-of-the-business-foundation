import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";

const BASE_ENV = {
  VALKEY_URL: "redis://valkey:6379",
  SITE_URL: "http://localhost:4321",
  CONSENT_POLICY_VERSION: "2026-10-01",
} as const;

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

let stderr: MockInstance<typeof console.error>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitCalled(code);
  });
});

/** 検証に失敗させ、stderr に出た文面を返す */
function loadInvalid(env: Record<string, string>): string {
  expect(() => loadConfig(env)).toThrow(ExitCalled);
  expect(exit).toHaveBeenCalledWith(1);
  return stderr.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("loadConfig", () => {
  describe("正常系", () => {
    it("必須の 3 つだけで起動でき、残りは既定値になる", () => {
      const config = loadConfig({ ...BASE_ENV });
      expect(config).toMatchObject({
        HOST: "0.0.0.0",
        PORT: 3104,
        VALKEY_KEY_PREFIX: "consent:",
        COOKIE_DOMAIN: "",
      });
      expect(config.VALKEY_PASSWORD).toBeUndefined();
    });

    it("PORT は文字列から数値に変換する", () => {
      expect(loadConfig({ ...BASE_ENV, PORT: "8080" }).PORT).toBe(8080);
    });

    it("空入力: 空の VALKEY_PASSWORD は未設定（認証なし）として扱う", () => {
      expect(loadConfig({ ...BASE_ENV, VALKEY_PASSWORD: "" }).VALKEY_PASSWORD).toBeUndefined();
    });

    it("空入力: 空の COOKIE_DOMAIN は Domain 属性なし（開発の localhost）として受け付ける", () => {
      expect(loadConfig({ ...BASE_ENV, COOKIE_DOMAIN: "" }).COOKIE_DOMAIN).toBe("");
    });

    it.each([
      ["HOST", "0.0.0.0"],
      ["PORT", 3104],
      ["VALKEY_KEY_PREFIX", "consent:"],
    ] as const)("空入力: 既定値のある %s が空・空白だけなら、止まらずに既定値（%j）で起動する", (name, expected) => {
      for (const value of ["", "  "]) {
        expect(loadConfig({ ...BASE_ENV, [name]: value })[name]).toBe(expected);
      }
    });

    it("VALKEY_PASSWORD があればそのまま渡す", () => {
      expect(loadConfig({ ...BASE_ENV, VALKEY_PASSWORD: "token-value" }).VALKEY_PASSWORD).toBe("token-value");
    });

    it("SITE_URL にパスや末尾のスラッシュが付いていても、オリジンだけに正規化する", () => {
      expect(loadConfig({ ...BASE_ENV, SITE_URL: "https://comegin.com/ja/blog/?q=1" }).SITE_URL).toBe(
        "https://comegin.com",
      );
      expect(loadConfig({ ...BASE_ENV, SITE_URL: "http://localhost:4321/" }).SITE_URL).toBe("http://localhost:4321");
    });

    it("SITE_URL に資格情報やフラグメントが付いていても、CORS の照合に使うオリジンには残さない", () => {
      expect(loadConfig({ ...BASE_ENV, SITE_URL: "https://user:pw@comegin.com/#top" }).SITE_URL).toBe(
        "https://comegin.com",
      );
    });

    it("本番の値（rediss:// と .comegin.com）を受け付ける", () => {
      const config = loadConfig({
        ...BASE_ENV,
        VALKEY_URL: "rediss://master.example.cache.amazonaws.com:6379",
        COOKIE_DOMAIN: ".comegin.com",
      });
      expect(config.VALKEY_URL).toBe("rediss://master.example.cache.amazonaws.com:6379");
      expect(config.COOKIE_DOMAIN).toBe(".comegin.com");
    });

    it("CONSENT_POLICY_VERSION は英数字と . _ - の 32 文字までを受け付ける", () => {
      const version = "v1.2_rc-".padEnd(32, "x");
      expect(loadConfig({ ...BASE_ENV, CONSENT_POLICY_VERSION: version }).CONSENT_POLICY_VERSION).toBe(version);
    });

    it("引数を省略すると process.env を読む", () => {
      vi.stubEnv("VALKEY_URL", "redis://from-env:6379");
      vi.stubEnv("SITE_URL", "https://comegin.com");
      vi.stubEnv("CONSENT_POLICY_VERSION", "2026-10-01");
      vi.stubEnv("PORT", "4000");
      expect(loadConfig()).toMatchObject({ VALKEY_URL: "redis://from-env:6379", PORT: 4000 });
    });
  });

  describe("異常系", () => {
    it.each([
      ["VALKEY_URL", "http://valkey:6379"],
      ["VALKEY_URL", "redis://"],
      ["SITE_URL", "ftp://comegin.com"],
      ["SITE_URL", "javascript:alert(1)"],
      ["PORT", "0"],
      ["PORT", "65536"],
      ["PORT", "abc"],
      ["PORT", "80.5"],
      ["COOKIE_DOMAIN", "comegin.com; Secure"],
      ["COOKIE_DOMAIN", "-comegin.com"],
      ["COOKIE_DOMAIN", "comegin.com."],
      ["CONSENT_POLICY_VERSION", "2026/10/01"],
      ["CONSENT_POLICY_VERSION", "v;HttpOnly"],
      ["CONSENT_POLICY_VERSION", "x".repeat(33)],
      ["VALKEY_KEY_PREFIX", "p".repeat(65)],
    ])("入力: %s=%j は終了コード 1 で止まる", (name, value) => {
      const output = loadInvalid({ ...BASE_ENV, [name]: value });
      expect(output).toContain(`- ${name}:`);
    });

    it.each([
      ["CONSENT_POLICY_VERSION", ""],
      ["CONSENT_POLICY_VERSION", "   "],
      ["VALKEY_URL", ""],
    ])("空入力: %s=%j は終了コード 1 で止まる", (name, value) => {
      const output = loadInvalid({ ...BASE_ENV, [name]: value });
      expect(output).toContain(`- ${name}:`);
    });

    it.each(["VALKEY_URL", "SITE_URL", "CONSENT_POLICY_VERSION"])("空入力: 必須の %s が無ければ止まる", (name) => {
      const env: Record<string, string> = { ...BASE_ENV };
      delete env[name];
      expect(loadInvalid(env)).toContain(`- ${name}:`);
    });

    it("空入力: 環境変数が 1 つも無ければ、必須の 3 つをまとめて報告して止まる", () => {
      const output = loadInvalid({});
      for (const name of ["VALKEY_URL", "SITE_URL", "CONSENT_POLICY_VERSION"]) {
        expect(output).toContain(`- ${name}:`);
      }
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("入力: 失敗時は変数名と理由だけを出し、値（シークレットを含みうる）は出さない", () => {
      const secretUrl = "http://user:super-secret-password@valkey:6379";
      const output = loadInvalid({ ...BASE_ENV, VALKEY_URL: secretUrl });
      expect(output).toContain("VALKEY_URL");
      expect(output).toContain("redis:// または rediss:// で始まる URL にしてください");
      expect(output).not.toContain("super-secret-password");
      expect(output).not.toContain(secretUrl);
    });

    it("入力: ほかの変数の誤りで止まるときも、VALKEY_PASSWORD の値は出さない", () => {
      const output = loadInvalid({ ...BASE_ENV, VALKEY_PASSWORD: "auth-token-should-not-leak", PORT: "0" });
      expect(output).toContain("- PORT:");
      expect(output).not.toContain("auth-token-should-not-leak");
    });

    it.each(["comegin.com", "", "not a url"])(
      "入力: URL として読めない SITE_URL（%j）も、変数名と理由だけを出して exit(1) する",
      (value) => {
        const output = loadInvalid({ ...BASE_ENV, SITE_URL: value });
        expect(output).toContain("SITE_URL");
        expect(output).toContain("http または https の URL にしてください");
        if (value) expect(output).not.toContain(value);
      },
    );

    it("入力: 複数の誤りはまとめて 1 回で報告する", () => {
      const output = loadInvalid({ SITE_URL: "ftp://x", PORT: "0" });
      for (const name of ["VALKEY_URL", "SITE_URL", "PORT", "CONSENT_POLICY_VERSION"]) {
        expect(output).toContain(`- ${name}:`);
      }
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });
});

// Lambda の入口が使う。プロセスを終了させず、例外にする（初期化の失敗として次の呼び出しでやり直すため）
describe("parseConfig", () => {
  describe("正常系", () => {
    it("正しい環境変数なら loadConfig と同じ設定を返し、何も出さない", () => {
      expect(parseConfig({ ...BASE_ENV })).toEqual(loadConfig({ ...BASE_ENV }));
      expect(stderr).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("空入力: 環境変数が 1 つも無ければ、必須の 3 つを並べた ConfigError を投げ、終了しない", () => {
      const error = (() => {
        try {
          parseConfig({});
        } catch (e) {
          return e;
        }
      })() as ConfigError;
      expect(error).toBeInstanceOf(ConfigError);
      for (const name of ["VALKEY_URL", "SITE_URL", "CONSENT_POLICY_VERSION"]) expect(error.message).toContain(`- ${name}:`);
      expect(exit).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    });

    it("入力: 例外のメッセージに値（シークレットを含みうる）を入れない", () => {
      expect(() => parseConfig({ ...BASE_ENV, VALKEY_URL: "http://secret-host:6379", VALKEY_PASSWORD: "pw-should-not-leak" })).toThrow(ConfigError);
      try {
        parseConfig({ ...BASE_ENV, VALKEY_URL: "http://secret-host:6379", VALKEY_PASSWORD: "pw-should-not-leak" });
      } catch (e) {
        expect((e as Error).message).not.toContain("secret-host");
        expect((e as Error).message).not.toContain("pw-should-not-leak");
      }
    });
  });
});
