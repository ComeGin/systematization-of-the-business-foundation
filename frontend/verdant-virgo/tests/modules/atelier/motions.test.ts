import { describe, expect, it } from "vitest";
import { MOTIONS, pickMotion } from "@/modules/atelier/client";

// 代表のアバターの身ぶり（spec §6.4）。押すとランダムに 1 つ。直前と同じものは続けて選ばない。

describe("pickMotion", () => {
  describe("正常系", () => {
    it("MOTIONS は 6 つ（idle を含まない）", () => {
      expect(MOTIONS).toHaveLength(6);
      expect(MOTIONS).not.toContain("idle");
    });

    it("直前と同じものは選ばない", () => {
      expect(pickMotion(MOTIONS[0], () => 0)).not.toBe(MOTIONS[0]);
      for (const last of MOTIONS) {
        for (const r of [0, 0.3, 0.6, 0.999]) {
          expect(pickMotion(last, () => r)).not.toBe(last);
        }
      }
    });

    it("random の値に応じて 6 つすべてが選ばれうる", () => {
      const got = new Set(
        Array.from({ length: 6 }, (_, i) => pickMotion(null, () => i / 6)),
      );
      expect(got.size).toBe(6);
    });
  });

  describe("異常系", () => {
    it("空入力: last が null なら random だけで決まる", () => {
      expect(pickMotion(null, () => 0)).toBe(MOTIONS[0]);
      expect(pickMotion(null, () => 0.999)).toBe(MOTIONS[5]);
    });
  });
});
