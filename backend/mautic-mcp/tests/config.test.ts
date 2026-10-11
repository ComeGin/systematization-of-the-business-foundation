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
  return stderr.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
}

describe("loadConfig", () => {
  describe("正常系", () => {
    it("空入力: 未指定（undefined）の項目に既定値が入る（read_only・http・127.0.0.1:3100）", () => {
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

    it("空入力: MCP_ALLOWED_HOSTS 未指定なら undefined のまま", () => {
      expect(loadConfig({ ...base }).MCP_ALLOWED_HOSTS).toBeUndefined();
    });

    it("空入力: TRANSPORT=stdio なら MCP_AUTH_TOKEN がなくても通る", () => {
      const { MCP_AUTH_TOKEN: _omit, ...env } = base;
      expect(loadConfig({ ...env, TRANSPORT: "stdio" }).TRANSPORT).toBe("stdio");
    });

    it("MCP_AUTH_TOKEN はちょうど 32 文字なら通る", () => {
      expect(loadConfig({ ...base, MCP_AUTH_TOKEN: "x".repeat(32) }).MCP_AUTH_TOKEN).toHaveLength(32);
    });

    it("アクセスレベル・トランスポートは許可した値ならそのまま使う", () => {
      const config = loadConfig({ ...base, MAUTIC_ACCESS_LEVEL: "full", TRANSPORT: "stdio" });
      expect(config.MAUTIC_ACCESS_LEVEL).toBe("full");
      expect(config.TRANSPORT).toBe("stdio");
    });
  });

  describe("異常系", () => {
    it("空入力: TRANSPORT=http（既定）で MCP_AUTH_TOKEN がなければ exit(1) する", () => {
      const { MCP_AUTH_TOKEN: _omit, ...env } = base;
      expect(() => loadConfig(env)).toThrow("process.exit(1)");
      expect(stderrText()).toContain("MCP_AUTH_TOKEN: TRANSPORT=http の場合は必須です");
    });

    // MCP_AUTH_TOKEN の要否（refine）は、ほかの項目の検証が通ってから判定されるため、ここでは挙がらない
    it("空入力: 環境変数が 1 つもなければ、Mautic の必須の変数名をすべて挙げて exit(1) する", () => {
      expect(() => loadConfig({})).toThrow("process.exit(1)");
      const text = stderrText();
      for (const name of ["MAUTIC_BASE_URL", "MAUTIC_CLIENT_ID", "MAUTIC_CLIENT_SECRET"]) {
        expect(text, name).toMatch(new RegExp(`- ${name}: `));
      }
    });

    it("空入力: 必須の認証情報が空文字なら変数名を挙げて exit(1) する", () => {
      expect(() => loadConfig({ ...base, MAUTIC_CLIENT_ID: "", MAUTIC_CLIENT_SECRET: "" })).toThrow("process.exit(1)");
      expect(stderrText()).toMatch(/- MAUTIC_CLIENT_ID: /);
      expect(stderrText()).toMatch(/- MAUTIC_CLIENT_SECRET: /);
    });

    it("空入力: MAUTIC_BASE_URL が空文字なら exit(1) する", () => {
      expect(() => loadConfig({ ...base, MAUTIC_BASE_URL: "" })).toThrow("process.exit(1)");
      expect(stderrText()).toMatch(/- MAUTIC_BASE_URL: /);
    });

    it("空入力: TRANSPORT=http で MCP_AUTH_TOKEN が空文字なら、未指定と同じく「必須」で exit(1) する", () => {
      expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN: "" })).toThrow("process.exit(1)");
      expect(stderrText()).toContain("MCP_AUTH_TOKEN: TRANSPORT=http の場合は必須です");
      expect(stderrText()).not.toContain("32 文字以上");
    });

    // .env.example のまま「MCP_AUTH_TOKEN=」で stdio にしても、README のとおり未指定と同じに通る（空文字・空白は未設定として扱う）
    it("空入力: TRANSPORT=stdio で MCP_AUTH_TOKEN が空文字・空白なら未指定と同じに通す", () => {
      for (const value of ["", "   "]) {
        const config = loadConfig({ ...base, TRANSPORT: "stdio", MCP_AUTH_TOKEN: value });
        expect(config.TRANSPORT).toBe("stdio");
        expect(config.MCP_AUTH_TOKEN).toBeUndefined();
      }
    });

    // [] にすると createMcpExpressApp が hostHeaderValidation([]) を入れ、どの Host ヘッダーでも 403 になるため、空は未指定と同じにする
    it("空入力: MCP_ALLOWED_HOSTS が空文字・空白とカンマだけなら undefined にする", () => {
      for (const value of ["", " , ", ","]) {
        expect(loadConfig({ ...base, MCP_ALLOWED_HOSTS: value }).MCP_ALLOWED_HOSTS).toBeUndefined();
      }
    });

    it("入力: MCP_AUTH_TOKEN が 31 文字なら理由付きで exit(1) し、値は出さない", () => {
      const short = "s3cr3t-value-".padEnd(31, "z");
      expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN: short })).toThrow("process.exit(1)");
      expect(stderrText()).toContain("MCP_AUTH_TOKEN: 32 文字以上にしてください");
      expect(stderrText()).not.toContain(short);
    });

    it("入力: 不正な値は変数名と理由だけを出し、値そのものは出さない", () => {
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

    it.each(["abc", "80.5", "-1"])("入力: PORT=%s（整数でない・範囲外）なら exit(1) する", (port) => {
      expect(() => loadConfig({ ...base, PORT: port })).toThrow("process.exit(1)");
      expect(stderrText()).toMatch(/- PORT: /);
    });

    it("入力: 未知の TRANSPORT なら exit(1) する", () => {
      expect(() => loadConfig({ ...base, TRANSPORT: "sse" })).toThrow("process.exit(1)");
      expect(stderrText()).toMatch(/- TRANSPORT: /);
    });

    it("入力: 検証失敗のメッセージに他の変数の秘密値（クライアントシークレット）を含めない", () => {
      expect(() => loadConfig({ ...base, PORT: "0" })).toThrow("process.exit(1)");
      expect(stderrText()).not.toContain(base.MAUTIC_CLIENT_SECRET);
      expect(stderrText()).not.toContain(TOKEN);
    });
  });
});
