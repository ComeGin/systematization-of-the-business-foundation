import { describe, expect, it } from "vitest";
import { APP_LAYOUT_LABELS } from "@/components/layout/labels";

// 定数表の検査なので正常系だけ（異常が起こりえない）
describe("APP_LAYOUT_LABELS", () => {
  describe("正常系", () => {
    it("AppLayoutToolbar のナビゲーション・ヘルプ・通知の読み上げ用ラベルをすべて持つ", () => {
      expect(Object.keys(APP_LAYOUT_LABELS).sort()).toEqual(
        ["navigation", "navigationClose", "navigationToggle", "notifications", "tools", "toolsClose", "toolsToggle"].sort(),
      );
    });

    it("ラベルはすべて空でない文字列で、重複しない（読み上げで区別できる）", () => {
      const values = Object.values(APP_LAYOUT_LABELS);
      for (const value of values) expect(value.trim()).not.toBe("");
      expect(new Set(values).size).toBe(values.length);
    });
  });
});
