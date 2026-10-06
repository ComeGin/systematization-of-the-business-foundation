import { describe, expect, it } from "vitest";
import { loadAlbConfig, loadConfig } from "../src/config.js";
import { captureStderr, DB_PASSWORD, mockExit, SECRET, validEnv } from "./helpers/env.js";

function expectExit(fn: () => unknown) {
  const exit = mockExit();
  const stderr = captureStderr();
  expect(fn).toThrow("process.exit(1)");
  expect(exit).toHaveBeenCalledWith(1);
  return stderr.text();
}

describe("loadConfig", () => {
  it("必須の変数だけで既定値を補う", () => {
    const config = loadConfig(validEnv());
    expect(config).toMatchObject({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 3103,
      DATABASE_PORT: 5432,
      DATABASE_NAME: "admin_auth",
      DATABASE_SSL: false,
      GOOGLE_HOSTED_DOMAIN: "comegin.com",
      ADMIN_BOOTSTRAP_EMAILS: [],
    });
  });

  it("BETTER_AUTH_URL はパスとクエリを落としてオリジンにする", () => {
    expect(loadConfig(validEnv({ BETTER_AUTH_URL: "https://auth.comegin.com/api/auth?x=1" })).BETTER_AUTH_URL).toBe(
      "https://auth.comegin.com",
    );
  });

  it("http・https 以外の BETTER_AUTH_URL を拒否する", () => {
    const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_URL: "ftp://auth.comegin.com" })));
    expect(text).toContain("BETTER_AUTH_URL");
  });

  it.each(["not a url", "", "auth.comegin.com"])("URL として読めない BETTER_AUTH_URL（%j）も、変数名と理由だけを出して終了する", (value) => {
    const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_URL: value })));
    expect(text).toContain("BETTER_AUTH_URL");
    expect(text).toContain("http または https の URL にしてください");
    if (value) expect(text).not.toContain(value);
  });

  it("BETTER_AUTH_SECRET が 32 文字未満なら、変数名と理由だけを出して値は出さずに終了する", () => {
    const short = "short-secret-value";
    const text = expectExit(() => loadConfig(validEnv({ BETTER_AUTH_SECRET: short })));
    expect(text).toContain("BETTER_AUTH_SECRET");
    expect(text).toContain("32 文字以上");
    expect(text).not.toContain(short);
  });

  it("ほかの変数の誤りを報告するときも、シークレットの値を出さない", () => {
    const text = expectExit(() => loadConfig(validEnv({ DATABASE_HOST: "", PORT: "70000" })));
    expect(text).toContain("DATABASE_HOST");
    expect(text).toContain("PORT");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(DB_PASSWORD);
  });

  it("必須の変数が無いときは変数名を列挙する", () => {
    const text = expectExit(() => loadConfig({}));
    for (const key of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "DATABASE_HOST", "DATABASE_USERNAME", "DATABASE_PASSWORD"]) {
      expect(text).toContain(key);
    }
  });

  it("DATABASE_SSL は文字列の true だけを真にする", () => {
    expect(loadConfig(validEnv({ DATABASE_SSL: "true" })).DATABASE_SSL).toBe(true);
    expect(loadConfig(validEnv({ DATABASE_SSL: "false" })).DATABASE_SSL).toBe(false);
  });

  it("DATABASE_SSL に true・false 以外を書くと拒否する", () => {
    expect(expectExit(() => loadConfig(validEnv({ DATABASE_SSL: "yes" })))).toContain("DATABASE_SSL");
  });

  it("PORT の範囲外（0）を拒否する", () => {
    expect(expectExit(() => loadConfig(validEnv({ PORT: "0" })))).toContain("PORT");
  });

  it("GOOGLE_HOSTED_DOMAIN は小文字のドメイン名だけを受け付ける", () => {
    expect(loadConfig(validEnv({ GOOGLE_HOSTED_DOMAIN: "example.co.jp" })).GOOGLE_HOSTED_DOMAIN).toBe("example.co.jp");
    expect(expectExit(() => loadConfig(validEnv({ GOOGLE_HOSTED_DOMAIN: "Comegin.com" })))).toContain("GOOGLE_HOSTED_DOMAIN");
  });

  it("GOOGLE_HOSTED_DOMAIN にトップレベルだけ（ドットなし）は書けない", () => {
    expect(expectExit(() => loadConfig(validEnv({ GOOGLE_HOSTED_DOMAIN: "localhost" })))).toContain("GOOGLE_HOSTED_DOMAIN");
  });

  it("ADMIN_BOOTSTRAP_EMAILS は前後の空白を除き、小文字にし、空の要素を捨てる", () => {
    const config = loadConfig(validEnv({ ADMIN_BOOTSTRAP_EMAILS: " Alice@Comegin.com , ,bob@comegin.com," }));
    expect(config.ADMIN_BOOTSTRAP_EMAILS).toEqual(["alice@comegin.com", "bob@comegin.com"]);
  });

  it("ADMIN_BOOTSTRAP_EMAILS にメールの形式でない要素があれば拒否し、その要素を出さない", () => {
    const text = expectExit(() => loadConfig(validEnv({ ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com,not-an-email-xyz" })));
    expect(text).toContain("ADMIN_BOOTSTRAP_EMAILS");
    expect(text).not.toContain("not-an-email-xyz");
  });

  it("空文字の GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET は未設定として扱う", () => {
    const config = loadConfig(validEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }));
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.GOOGLE_CLIENT_SECRET).toBeUndefined();
  });

  it("開発では Google の ID とシークレットが無くても起動できる", () => {
    expect(() => loadConfig(validEnv({ NODE_ENV: "development" }))).not.toThrow();
  });

  it("NODE_ENV=production では Google の ID とシークレットを必須にする", () => {
    const text = expectExit(() => loadConfig(validEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "" })));
    expect(text).toContain("GOOGLE_CLIENT_ID");
    expect(text).toContain("GOOGLE_CLIENT_SECRET");
  });

  it("NODE_ENV=production で両方あれば通り、シークレットの値はそのまま保持する", () => {
    const config = loadConfig(
      validEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret" }),
    );
    expect(config.GOOGLE_CLIENT_SECRET).toBe("gsecret");
  });

  it("想定外の NODE_ENV を拒否する", () => {
    expect(expectExit(() => loadConfig(validEnv({ NODE_ENV: "staging" })))).toContain("NODE_ENV");
  });
});

describe("loadAlbConfig", () => {
  const albEnv = (overrides: Record<string, string> = {}) => ({
    ALB_CLIENT_ID: "alb-admin_gate",
    ALB_CLIENT_SECRET: "alb-secret-0123456789abcdefghijklmnopq",
    ALB_PROTECTED_HOSTS: "mautic.comegin.com",
    ...overrides,
  });

  it("ホスト名は前後の空白を除いて小文字にし、空の要素を捨てる", () => {
    const config = loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: " Mautic.Comegin.com, ,n8n.comegin.com " }));
    expect(config.ALB_PROTECTED_HOSTS).toEqual(["mautic.comegin.com", "n8n.comegin.com"]);
  });

  it("スキームやパスの付いたホストを拒否する", () => {
    expect(expectExit(() => loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: "https://mautic.comegin.com" })))).toContain(
      "ALB_PROTECTED_HOSTS",
    );
    expect(expectExit(() => loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: "mautic.comegin.com/x" })))).toContain(
      "ALB_PROTECTED_HOSTS",
    );
  });

  it("ホストが 1 つも無ければ拒否する", () => {
    expect(expectExit(() => loadAlbConfig(albEnv({ ALB_PROTECTED_HOSTS: " , " })))).toContain("1 つ以上");
  });

  it("ALB_CLIENT_ID は 8 文字以上の英数字と _ - だけ", () => {
    expect(expectExit(() => loadAlbConfig(albEnv({ ALB_CLIENT_ID: "short" })))).toContain("ALB_CLIENT_ID");
    expect(expectExit(() => loadAlbConfig(albEnv({ ALB_CLIENT_ID: "has space id" })))).toContain("ALB_CLIENT_ID");
  });

  it("ALB_CLIENT_SECRET が短いときは、値を出さずに終了する", () => {
    const short = "alb-short-secret";
    const text = expectExit(() => loadAlbConfig(albEnv({ ALB_CLIENT_SECRET: short })));
    expect(text).toContain("ALB_CLIENT_SECRET");
    expect(text).not.toContain(short);
  });
});
