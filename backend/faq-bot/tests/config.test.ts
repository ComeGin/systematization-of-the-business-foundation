import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE_ENV = {
  CHATWOOT_BASE_URL: "http://127.0.0.1:3100",
  CHATWOOT_ACCOUNT_ID: "1",
  CHATWOOT_BOT_TOKEN: "bot-token-value",
  CHATWOOT_BOT_SECRET: "0123456789abcdef0123",
  FAQ_URL: "http://localhost:4321/faq.json",
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
    it("必須の 5 つだけで起動でき、残りは既定値になる", () => {
      expect(loadConfig({ ...BASE_ENV })).toMatchObject({
        HOST: "127.0.0.1",
        PORT: 3107,
        CHATWOOT_ACCOUNT_ID: 1,
        FAQ_REFRESH_SECONDS: 600,
        FAQ_MATCH_HIGH: 0.5,
        FAQ_MATCH_LOW: 0.25,
        FAQ_MATCH_MARGIN: 0.1,
      });
    });

    it("CHATWOOT_BASE_URL の末尾の / を外す", () => {
      expect(loadConfig({ ...BASE_ENV, CHATWOOT_BASE_URL: "https://chat.comegin.com/" }).CHATWOOT_BASE_URL).toBe("https://chat.comegin.com");
    });

    it("空入力: 既定値のある変数が空なら既定値を使う", () => {
      const config = loadConfig({ ...BASE_ENV, PORT: "", FAQ_MATCH_HIGH: "", FAQ_REFRESH_SECONDS: " " });
      expect(config.PORT).toBe(3107);
      expect(config.FAQ_MATCH_HIGH).toBe(0.5);
      expect(config.FAQ_REFRESH_SECONDS).toBe(600);
    });
  });

  describe("異常系", () => {
    it("空入力: 必須の変数が無いと、変数名を出して終了する", () => {
      const out = loadInvalid({});
      for (const name of ["CHATWOOT_BASE_URL", "CHATWOOT_ACCOUNT_ID", "CHATWOOT_BOT_TOKEN", "CHATWOOT_BOT_SECRET", "FAQ_URL"]) {
        expect(out).toContain(name);
      }
    });

    it("入力: 値（秘密値）は出力しない", () => {
      const out = loadInvalid({ ...BASE_ENV, CHATWOOT_BOT_SECRET: "xyzSECRET" });
      expect(out).toContain("CHATWOOT_BOT_SECRET");
      expect(out).not.toContain("xyzSECRET");
    });

    it("入力: http・https 以外の URL は受け付けない", () => {
      expect(loadInvalid({ ...BASE_ENV, FAQ_URL: "ftp://example.com/faq.json" })).toContain("FAQ_URL");
    });

    it("入力: しきい値が 0〜1 の外なら受け付けない", () => {
      expect(loadInvalid({ ...BASE_ENV, FAQ_MATCH_HIGH: "1.5" })).toContain("FAQ_MATCH_HIGH");
    });

    it("入力: FAQ_MATCH_LOW が FAQ_MATCH_HIGH より大きいと受け付けない", () => {
      expect(loadInvalid({ ...BASE_ENV, FAQ_MATCH_HIGH: "0.5", FAQ_MATCH_LOW: "0.6" })).toContain("FAQ_MATCH_LOW");
    });

    it("入力: CHATWOOT_ACCOUNT_ID が正の整数でないと受け付けない", () => {
      expect(loadInvalid({ ...BASE_ENV, CHATWOOT_ACCOUNT_ID: "abc" })).toContain("CHATWOOT_ACCOUNT_ID");
    });
  });
});
