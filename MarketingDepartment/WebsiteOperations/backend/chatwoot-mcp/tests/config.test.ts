import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";

const TOKEN_32 = "a".repeat(32);

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CHATWOOT_BASE_URL: "http://localhost:3100",
    CHATWOOT_API_ACCESS_TOKEN: "chatwoot-user-token",
    CHATWOOT_ACCOUNT_ID: "1",
    ...overrides,
  };
}

describe("loadConfig", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit でテストプロセスが落ちないよう、例外に置き換える
    exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exit.mockRestore();
    stderr.mockRestore();
  });

  /** 検証失敗時に stderr へ出た文面 */
  function failureOutput(env: NodeJS.ProcessEnv): string {
    expect(() => loadConfig(env)).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
    return stderr.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  describe("正常系", () => {
    it("必須の 3 変数だけで、残りは既定値になる", () => {
      const config = loadConfig(baseEnv());
      expect(config).toMatchObject({
        CHATWOOT_ACCESS_LEVEL: "read_only",
        CHATWOOT_TIMEZONE_OFFSET: 9,
        TRANSPORT: "stdio",
        HOST: "127.0.0.1",
        PORT: 3102,
      });
      expect(config.MCP_AUTH_TOKEN).toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    });

    it("CHATWOOT_BASE_URL の末尾のスラッシュを取り除く", () => {
      expect(loadConfig(baseEnv({ CHATWOOT_BASE_URL: "https://chat.example.com//" })).CHATWOOT_BASE_URL).toBe("https://chat.example.com");
    });

    it("数値の変数は文字列から数値に変換する", () => {
      const config = loadConfig(baseEnv({ CHATWOOT_ACCOUNT_ID: "7", CHATWOOT_TIMEZONE_OFFSET: "-3.5", PORT: "4000" }));
      expect(config.CHATWOOT_ACCOUNT_ID).toBe(7);
      expect(config.CHATWOOT_TIMEZONE_OFFSET).toBe(-3.5);
      expect(config.PORT).toBe(4000);
    });

    it("MCP_ALLOWED_HOSTS はカンマで分け、前後の空白と空要素を除く", () => {
      const config = loadConfig(baseEnv({ MCP_ALLOWED_HOSTS: " a.example.com, ,b.example.com ," }));
      expect(config.MCP_ALLOWED_HOSTS).toEqual(["a.example.com", "b.example.com"]);
    });

    it("TRANSPORT=http は 32 文字以上の MCP_AUTH_TOKEN があれば通る", () => {
      const config = loadConfig(baseEnv({ TRANSPORT: "http", MCP_AUTH_TOKEN: TOKEN_32 }));
      expect(config.TRANSPORT).toBe("http");
      expect(config.MCP_AUTH_TOKEN).toBe(TOKEN_32);
    });

    it("引数を省略すると process.env を読む", () => {
      vi.stubEnv("CHATWOOT_BASE_URL", "http://127.0.0.1:3100/");
      vi.stubEnv("CHATWOOT_API_ACCESS_TOKEN", "from-process-env");
      vi.stubEnv("CHATWOOT_ACCOUNT_ID", "3");
      vi.stubEnv("CHATWOOT_ACCESS_LEVEL", "full");
      vi.stubEnv("TRANSPORT", "stdio");
      vi.stubEnv("MCP_AUTH_TOKEN", undefined);
      const config = loadConfig();
      expect(config.CHATWOOT_BASE_URL).toBe("http://127.0.0.1:3100");
      expect(config.CHATWOOT_ACCOUNT_ID).toBe(3);
      expect(config.CHATWOOT_ACCESS_LEVEL).toBe("full");
    });
  });

  describe("検証失敗", () => {
    it("TRANSPORT=http で MCP_AUTH_TOKEN がないと exit(1) し、変数名と理由を出す", () => {
      const output = failureOutput(baseEnv({ TRANSPORT: "http" }));
      expect(output).toContain("MCP_AUTH_TOKEN");
      expect(output).toContain("TRANSPORT=http の場合は必須です");
    });

    it("MCP_AUTH_TOKEN が 31 文字だと拒否し、トークンの値は出さない", () => {
      const shortToken = "s3cr3t-".repeat(4) + "abc"; // 31 文字
      expect(shortToken).toHaveLength(31);
      const output = failureOutput(baseEnv({ TRANSPORT: "http", MCP_AUTH_TOKEN: shortToken }));
      expect(output).toContain("MCP_AUTH_TOKEN: 32 文字以上にしてください");
      expect(output).not.toContain(shortToken);
    });

    it("不正な値そのものは出力しない（変数名と理由だけ）", () => {
      const output = failureOutput(
        baseEnv({
          CHATWOOT_BASE_URL: "not-a-url-secret-host",
          CHATWOOT_ACCOUNT_ID: "-5",
          CHATWOOT_ACCESS_LEVEL: "superuser-secret-level",
          CHATWOOT_TIMEZONE_OFFSET: "99",
          TRANSPORT: "carrier-pigeon",
        }),
      );
      for (const name of ["CHATWOOT_BASE_URL", "CHATWOOT_ACCOUNT_ID", "CHATWOOT_ACCESS_LEVEL", "CHATWOOT_TIMEZONE_OFFSET", "TRANSPORT"]) {
        expect(output).toContain(`- ${name}:`);
      }
      for (const value of ["not-a-url-secret-host", "superuser-secret-level", "carrier-pigeon"]) {
        expect(output).not.toContain(value);
      }
    });

    it("CHATWOOT_API_ACCESS_TOKEN が空なら拒否する", () => {
      expect(failureOutput(baseEnv({ CHATWOOT_API_ACCESS_TOKEN: "" }))).toContain("CHATWOOT_API_ACCESS_TOKEN");
    });

    it("CHATWOOT_ACCOUNT_ID は正の整数に限る", () => {
      expect(failureOutput(baseEnv({ CHATWOOT_ACCOUNT_ID: "1.5" }))).toContain("CHATWOOT_ACCOUNT_ID");
    });

    it("PORT は 1〜65535 に限る", () => {
      expect(failureOutput(baseEnv({ PORT: "65536" }))).toContain("PORT");
    });

    it("CHATWOOT_TIMEZONE_OFFSET は -12〜14 に限る", () => {
      expect(failureOutput(baseEnv({ CHATWOOT_TIMEZONE_OFFSET: "-13" }))).toContain("CHATWOOT_TIMEZONE_OFFSET");
    });

    it("必須の変数が欠けているときも、欠けた変数名を出す", () => {
      const output = failureOutput({});
      for (const name of ["CHATWOOT_BASE_URL", "CHATWOOT_API_ACCESS_TOKEN", "CHATWOOT_ACCOUNT_ID"]) expect(output).toContain(name);
    });
  });

  it.todo(
    "不具合候補: .env.example どおり MCP_AUTH_TOKEN= を空のまま残すと、TRANSPORT=stdio でも「32 文字以上」で起動に失敗する（空文字は optional() の対象外。src/config.ts:16）",
  );
});
