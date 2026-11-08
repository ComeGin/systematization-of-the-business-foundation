import { describe, expect, it } from "vitest";
import { describeOutcome } from "@/components/common/failure-class";

const NINE = ["ok", "empty_but_ok", "timeout", "unreachable", "auth_failed", "permission_denied", "rate_limited", "truncated", "invalid_response"];

describe("describeOutcome", () => {
  describe("正常系", () => {
    it.each(NINE)("%s に日本語の label と meaning がある", (value) => {
      const result = describeOutcome(value);
      expect(result.label).not.toBe(value);
      expect(result.label.length).toBeGreaterThan(0);
      expect(result.meaning.length).toBeGreaterThan(0);
    });

    it("ok と empty_but_ok だけが ok: true", () => {
      expect(NINE.filter((value) => describeOutcome(value).ok)).toEqual(["ok", "empty_but_ok"]);
    });

    it("invalid_response の meaning に「5xx」を含む（2026-11-04 の 503 がこの分類に入った）", () => {
      expect(describeOutcome("invalid_response").meaning).toContain("5xx");
    });
  });

  describe("異常系", () => {
    it("入力: 定義に無い分類はそのままの値を label にして ok: false", () => {
      expect(describeOutcome("weird")).toEqual({ label: "weird", meaning: "定義に無い分類", ok: false });
    });

    it("空入力: null は「形が読めない」で ok: false", () => {
      expect(describeOutcome(null)).toMatchObject({ label: "形が読めない", ok: false });
    });
  });
});
