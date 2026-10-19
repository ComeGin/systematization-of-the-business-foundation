import { describe, expect, it } from "vitest";
import { formatCount } from "@/modules/motion/lib/count";

// 数え上げの途中の文字。数字の部分だけを progress（0〜1）で比例させ、小数の桁・桁区切り・前後の文字を保つ。
describe("motion/lib/count の formatCount", () => {
  describe("正常系", () => {
    it("小数の桁と単位を保つ", () => {
      expect(formatCount("72.2%", 1)).toBe("72.2%");
      expect(formatCount("72.2%", 0.5)).toBe("36.1%");
      expect(formatCount("72.2%", 0)).toBe("0.0%");
    });

    it("3 桁区切りを保つ", () => {
      expect(formatCount("1,234人", 1)).toBe("1,234人");
      expect(formatCount("1,234人", 0.5)).toBe("617人");
      expect(formatCount("1,234人", 0)).toBe("0人");
    });

    it("整数は整数のまま（小数の桁を足さない）", () => {
      expect(formatCount("40社", 0.25)).toBe("10社");
    });

    it("前後の文字をそのまま残す", () => {
      expect(formatCount("全国で 50.8% です", 0)).toBe("全国で 0.0% です");
      expect(formatCount("全国で 50.8% です", 1)).toBe("全国で 50.8% です");
    });

    it("数字が複数あれば、それぞれを比例させる", () => {
      expect(formatCount("10〜20人", 0.5)).toBe("5〜10人");
    });
  });

  describe("異常系", () => {
    it("空入力: 空文字は空文字", () => {
      expect(formatCount("", 0.5)).toBe("");
    });

    it("入力: 数字が無ければそのまま", () => {
      expect(formatCount("—", 0.3)).toBe("—");
      expect(formatCount("要相談", 0)).toBe("要相談");
    });

    it("入力: progress は 0〜1 に丸める", () => {
      expect(formatCount("50.8%", 2)).toBe("50.8%");
      expect(formatCount("50.8%", -1)).toBe("0.0%");
    });

    it("入力: 数字の直後のカンマは残す（3 桁区切りと取り違えない）", () => {
      expect(formatCount("10, 20", 1)).toBe("10, 20");
      expect(formatCount("10, 20", 0.5)).toBe("5, 10");
      expect(formatCount("1,234, 5", 1)).toBe("1,234, 5");
    });

    it("入力: progress が数でない（NaN）なら 0 として扱う", () => {
      expect(formatCount("50.8%", Number.NaN)).toBe("0.0%");
    });
  });
});
