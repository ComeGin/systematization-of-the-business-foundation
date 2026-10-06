import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadConfig } from "../src/config.js";

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

describe("loadConfig: 既定値と正規化", () => {
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

  it("空の VALKEY_PASSWORD は未設定（認証なし）として扱う", () => {
    expect(loadConfig({ ...BASE_ENV, VALKEY_PASSWORD: "" }).VALKEY_PASSWORD).toBeUndefined();
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

describe("loadConfig: 不正な値を拒否する", () => {
  it.each([
    ["VALKEY_URL", "http://valkey:6379"],
    ["VALKEY_URL", "redis://"],
    ["SITE_URL", "ftp://comegin.com"],
    ["SITE_URL", "javascript:alert(1)"],
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "abc"],
    ["COOKIE_DOMAIN", "comegin.com; Secure"],
    ["COOKIE_DOMAIN", "-comegin.com"],
    ["COOKIE_DOMAIN", "comegin.com."],
    ["CONSENT_POLICY_VERSION", "2026/10/01"],
    ["CONSENT_POLICY_VERSION", "v;HttpOnly"],
    ["CONSENT_POLICY_VERSION", "x".repeat(33)],
    ["CONSENT_POLICY_VERSION", ""],
    ["VALKEY_KEY_PREFIX", "p".repeat(65)],
    ["VALKEY_KEY_PREFIX", ""],
    ["HOST", ""],
  ])("%s=%j は終了コード 1 で止まる", (name, value) => {
    const output = loadInvalid({ ...BASE_ENV, [name]: value });
    expect(output).toContain(`- ${name}:`);
  });

  it.each(["VALKEY_URL", "SITE_URL", "CONSENT_POLICY_VERSION"])("必須の %s が無ければ止まる", (name) => {
    const env: Record<string, string> = { ...BASE_ENV };
    delete env[name];
    expect(loadInvalid(env)).toContain(`- ${name}:`);
  });

  it("失敗時は変数名と理由だけを出し、値（シークレットを含みうる）は出さない", () => {
    const secretUrl = "http://user:super-secret-password@valkey:6379";
    const output = loadInvalid({ ...BASE_ENV, VALKEY_URL: secretUrl });
    expect(output).toContain("VALKEY_URL");
    expect(output).toContain("redis:// または rediss:// で始まる URL にしてください");
    expect(output).not.toContain("super-secret-password");
    expect(output).not.toContain(secretUrl);
  });

  it.each(["comegin.com", "", "not a url"])("URL として読めない SITE_URL（%j）も、変数名と理由だけを出して exit(1) する", (value) => {
    const output = loadInvalid({ ...BASE_ENV, SITE_URL: value });
    expect(output).toContain("SITE_URL");
    expect(output).toContain("http または https の URL にしてください");
    if (value) expect(output).not.toContain(value);
  });

  it("複数の誤りはまとめて 1 回で報告する", () => {
    const output = loadInvalid({ SITE_URL: "ftp://x", PORT: "0" });
    for (const name of ["VALKEY_URL", "SITE_URL", "PORT", "CONSENT_POLICY_VERSION"]) {
      expect(output).toContain(`- ${name}:`);
    }
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
