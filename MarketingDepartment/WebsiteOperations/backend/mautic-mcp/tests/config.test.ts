import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";

const TOKEN = "t".repeat(32);

const base = {
  MAUTIC_BASE_URL: "https://mautic.example.com",
  MAUTIC_CLIENT_ID: "client-id",
  MAUTIC_CLIENT_SECRET: "client-secret-value",
  MCP_AUTH_TOKEN: TOKEN,
};

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

function stderrText(): string {
  return stderr.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("loadConfig: 正常系", () => {
  it("未指定の項目に既定値が入る（read_only・http・127.0.0.1:3100）", () => {
    const config = loadConfig({ ...base });
    expect(config.MAUTIC_ACCESS_LEVEL).toBe("read_only");
    expect(config.TRANSPORT).toBe("http");
    expect(config.HOST).toBe("127.0.0.1");
    expect(config.PORT).toBe(3100);
  });

  it("MAUTIC_BASE_URL の末尾のスラッシュを取り除く", () => {
    expect(loadConfig({ ...base, MAUTIC_BASE_URL: "https://mautic.example.com///" }).MAUTIC_BASE_URL).toBe("https://mautic.example.com");
  });

  it("PORT は文字列から数値に変換する", () => {
    expect(loadConfig({ ...base, PORT: "8080" }).PORT).toBe(8080);
  });

  it("MCP_ALLOWED_HOSTS をカンマで分割し、前後の空白と空要素を除く", () => {
    const config = loadConfig({ ...base, MCP_ALLOWED_HOSTS: " a.ngrok.app , ,b.example.com," });
    expect(config.MCP_ALLOWED_HOSTS).toEqual(["a.ngrok.app", "b.example.com"]);
  });

  it("MCP_ALLOWED_HOSTS 未指定なら undefined のまま", () => {
    expect(loadConfig({ ...base }).MCP_ALLOWED_HOSTS).toBeUndefined();
  });

  it("TRANSPORT=stdio なら MCP_AUTH_TOKEN がなくても通る", () => {
    const { MCP_AUTH_TOKEN: _omit, ...env } = base;
    expect(loadConfig({ ...env, TRANSPORT: "stdio" }).TRANSPORT).toBe("stdio");
  });

  it("MCP_AUTH_TOKEN はちょうど 32 文字なら通る", () => {
    expect(loadConfig({ ...base, MCP_AUTH_TOKEN: "x".repeat(32) }).MCP_AUTH_TOKEN).toHaveLength(32);
  });
});

describe("loadConfig: 検証失敗", () => {
  it("TRANSPORT=http（既定）で MCP_AUTH_TOKEN がなければ exit(1) する", () => {
    const { MCP_AUTH_TOKEN: _omit, ...env } = base;
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
    expect(stderrText()).toContain("MCP_AUTH_TOKEN: TRANSPORT=http の場合は必須です");
  });

  it("MCP_AUTH_TOKEN が 31 文字なら理由付きで exit(1) し、値は出さない", () => {
    const short = "s3cr3t-value-".padEnd(31, "z");
    expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN: short })).toThrow("process.exit(1)");
    expect(stderrText()).toContain("MCP_AUTH_TOKEN: 32 文字以上にしてください");
    expect(stderrText()).not.toContain(short);
  });

  it("不正な値は変数名と理由だけを出し、値そのものは出さない", () => {
    const badUrl = "not-a-url-with-SECRET-inside";
    const badLevel = "admin-SECRET-level";
    expect(() => loadConfig({ ...base, MAUTIC_BASE_URL: badUrl, MAUTIC_ACCESS_LEVEL: badLevel, PORT: "70000" })).toThrow(
      "process.exit(1)",
    );
    const text = stderrText();
    expect(text).toContain("[config] 環境変数が不正です");
    expect(text).toMatch(/- MAUTIC_BASE_URL: /);
    expect(text).toMatch(/- MAUTIC_ACCESS_LEVEL: /);
    expect(text).toMatch(/- PORT: /);
    expect(text).not.toContain(badUrl);
    expect(text).not.toContain(badLevel);
    expect(text).not.toContain("70000");
  });

  it("必須の認証情報が空文字なら変数名を挙げて exit(1) する", () => {
    expect(() => loadConfig({ ...base, MAUTIC_CLIENT_ID: "", MAUTIC_CLIENT_SECRET: "" })).toThrow("process.exit(1)");
    expect(stderrText()).toMatch(/- MAUTIC_CLIENT_ID: /);
    expect(stderrText()).toMatch(/- MAUTIC_CLIENT_SECRET: /);
  });

  it("検証失敗のメッセージに他の変数の秘密値（クライアントシークレット）を含めない", () => {
    expect(() => loadConfig({ ...base, PORT: "0" })).toThrow("process.exit(1)");
    expect(stderrText()).not.toContain(base.MAUTIC_CLIENT_SECRET);
    expect(stderrText()).not.toContain(TOKEN);
  });
});
