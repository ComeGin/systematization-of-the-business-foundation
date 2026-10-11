import { describe, expect, it, vi } from "vitest";
import { logLine } from "../src/log.js";

describe("logLine", () => {
  describe("正常系", () => {
    it("stderr だけに「<ULID> <レベル> <連携点> <本文>」の 1 行を出す（stdout は使わない）", () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const write = vi.spyOn(process.stdout, "write");
      logLine("WARN", "I-13", "PR を作れない", "01JBQZ8F3K7XN2M5V9TWRC4HED");
      expect(stderr).toHaveBeenCalledExactlyOnceWith("01JBQZ8F3K7XN2M5V9TWRC4HED WARN I-13 PR を作れない");
      expect(stdout).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    });

    it("空入力: 相関 ID が無ければ（undefined・null）行頭は -", () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      logLine("INFO", "engine", "a");
      logLine("INFO", "engine", "b", null);
      expect(stderr.mock.calls.map((call) => call[0])).toEqual(["- INFO engine a", "- INFO engine b"]);
    });

    it("空入力: 本文が空文字・空白だけでも 1 行を出す（落ちない）", () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      logLine("INFO", "engine", "");
      logLine("INFO", "engine", " \n\t ");
      expect(stderr.mock.calls.map((call) => call[0])).toEqual(["- INFO engine ", "- INFO engine  "]);
    });

    it("空入力: 相関 ID が空文字なら、そのまま空として扱う（- に置き換えない）", () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      logLine("INFO", "engine", "a", "");
      expect(stderr).toHaveBeenCalledWith(" INFO engine a");
    });
  });

  describe("異常系", () => {
    it("入力: 本文の改行・連続空白を 1 つの空白にまとめ、1 行に収める（ログの行を偽装させない）", () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      logLine("ERROR", "x", "1 行目\n- ERROR forged 2 行目\t\tend");
      expect(stderr).toHaveBeenCalledWith("- ERROR x 1 行目 - ERROR forged 2 行目 end");
    });

    it("入力: 本文は 500 文字で切る", () => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      logLine("INFO", "x", "a".repeat(800));
      expect(String(stderr.mock.calls[0]?.[0])).toBe(`- INFO x ${"a".repeat(500)}`);
    });
  });
});
