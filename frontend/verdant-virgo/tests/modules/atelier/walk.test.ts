import { describe, expect, it } from "vitest";
import { createWalker } from "@/modules/atelier/client";

// 進む・止まるの加減速（spec §6.2）。動き出しはゆっくり加速し、止まるときもゆっくり止まる（急に止まらない。アンチゴール 2）。

const opts = { maxSpeed: 0.1, accelSec: 0.5, decelSec: 0.5 };
const run = (
  w: ReturnType<typeof createWalker>,
  sec: number,
  intent: -1 | 0 | 1,
) => {
  for (let i = 0; i < Math.round(sec / 0.01); i++) w.step(0.01, intent);
};

describe("createWalker", () => {
  describe("正常系", () => {
    it("intent 1 で速さは accelSec かけて maxSpeed に達する", () => {
      const w = createWalker(opts);
      run(w, 0.25, 1);
      expect(w.speed).toBeGreaterThan(0.045);
      expect(w.speed).toBeLessThan(0.055);
      run(w, 0.25, 1);
      expect(w.speed).toBeCloseTo(0.1, 5);
    });

    it("intent 0 にすると decelSec かけて 0 になり、t は戻らない", () => {
      const w = createWalker(opts);
      run(w, 1, 1);
      const before = w.t;
      run(w, 0.25, 0);
      expect(w.speed).toBeGreaterThan(0);
      expect(w.t).toBeGreaterThan(before);
      const mid = w.t;
      run(w, 0.3, 0);
      expect(w.speed).toBe(0);
      expect(w.t).toBeGreaterThanOrEqual(mid);
    });

    it("t は 1 を超えず、1 に着いたら速さ 0", () => {
      const w = createWalker({ ...opts, start: 0.99 });
      run(w, 2, 1);
      expect(w.t).toBe(1);
      expect(w.speed).toBe(0);
    });

    it("intent -1 で戻り、0 を下回らない", () => {
      const w = createWalker({ ...opts, start: 0.05 });
      run(w, 0.3, -1);
      expect(w.t).toBeLessThan(0.05);
      run(w, 3, -1);
      expect(w.t).toBe(0);
      expect(w.speed).toBe(0);
    });

    it("jumpTo で t を置き、速さは 0", () => {
      const w = createWalker(opts);
      run(w, 1, 1);
      w.jumpTo(0.4);
      expect(w.t).toBe(0.4);
      expect(w.speed).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: dt が負・NaN・1 秒を超える値は 0〜0.1 秒に収める", () => {
      const w = createWalker(opts);
      w.step(-1, 1);
      expect(w.t).toBe(0);
      w.step(Number.NaN, 1);
      expect(w.t).toBe(0);
      w.step(5, 1);
      // 0.1 秒ぶんだけ加速・前進する（タブの復帰で飛ばない）
      expect(w.speed).toBeCloseTo(0.02, 5);
      expect(w.t).toBeLessThanOrEqual(0.1 * 0.02 + 1e-9);
    });

    it("空入力: start を省くと t=0", () => {
      expect(createWalker(opts).t).toBe(0);
    });
  });
});
