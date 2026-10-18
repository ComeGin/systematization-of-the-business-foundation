import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "@/modules/a11y";

describe("relativeLuminance", () => {
  describe("正常系", () => {
    it("白は 1、黒は 0", () => {
      expect(relativeLuminance("#FFFFFF")).toBe(1);
      expect(relativeLuminance("#000000")).toBe(0);
    });

    it("#RGB と #RRGGBB は同じ値、大文字と小文字も同じ値", () => {
      expect(relativeLuminance("#08f")).toBe(relativeLuminance("#0088FF"));
      expect(relativeLuminance("#0471c0")).toBe(relativeLuminance("#0471C0"));
    });
  });
});

describe("contrastRatio", () => {
  describe("正常系", () => {
    it("白と黒は 21:1、同じ色は 1:1", () => {
      expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
      expect(contrastRatio("#0581DB", "#0581DB")).toBe(1);
    });

    it("前景と背景を入れ替えても同じ値", () => {
      expect(contrastRatio("#003577", "#FFFFFF")).toBe(
        contrastRatio("#FFFFFF", "#003577"),
      );
    });

    it("WCAG の境目の既知の値: #767676 は白地で 4.54:1（4.5 をわずかに超える）", () => {
      expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
    });

    it("計画書の実測と同じ値: 薄い地の text-link 4.22:1、白地の border 1.29:1、navy.700 の上の focus-ring 2.91:1", () => {
      expect(contrastRatio("#0579CE", "#F5F7F9")).toBeCloseTo(4.22, 2);
      expect(contrastRatio("#DCE3EA", "#FFFFFF")).toBeCloseTo(1.29, 2);
      expect(contrastRatio("#0581DB", "#003577")).toBeCloseTo(2.91, 2);
    });

    it("前後の空白と # の無い値も受ける", () => {
      expect(contrastRatio(" #FFFFFF ", "000000")).toBe(21);
    });
  });

  describe("異常系", () => {
    it("空入力: 空文字は例外", () => {
      expect(() => contrastRatio("", "#FFFFFF")).toThrow(/#RGB か #RRGGBB/);
    });

    it("入力: rgb() の形は例外（トークンの値は hex だけ）", () => {
      expect(() => contrastRatio("rgb(0, 0, 0)", "#FFFFFF")).toThrow(
        /#RGB か #RRGGBB/,
      );
    });

    it("入力: 透明度つきの #RRGGBBAA は例外", () => {
      expect(() => contrastRatio("#000000FF", "#FFFFFF")).toThrow(
        /#RGB か #RRGGBB/,
      );
    });

    it("入力: 16 進でない文字は例外", () => {
      expect(() => contrastRatio("#GGGGGG", "#FFFFFF")).toThrow(
        /#RGB か #RRGGBB/,
      );
    });
  });
});
