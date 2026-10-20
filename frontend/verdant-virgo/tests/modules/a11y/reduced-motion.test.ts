import { afterEach, describe, expect, it, vi } from "vitest";
import { onReducedMotionChange, prefersReducedMotion } from "@/modules/a11y";

type Listener = (event: { matches: boolean }) => void;

/** matchMedia を差し替えた window を置く。change を発火する関数と、購読の数を返す */
function stubWindow(matches: boolean) {
  const listeners = new Set<Listener>();
  const matchMedia = vi.fn((query: string) => ({
    matches,
    media: query,
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
  }));
  vi.stubGlobal("window", { matchMedia });
  return {
    matchMedia,
    fire: (next: boolean) => listeners.forEach((fn) => fn({ matches: next })),
    count: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prefersReducedMotion", () => {
  describe("正常系", () => {
    it("「視差効果を減らす」が有効なら true", () => {
      const { matchMedia } = stubWindow(true);
      expect(prefersReducedMotion()).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith(
        "(prefers-reduced-motion: reduce)",
      );
    });

    it("有効でなければ false", () => {
      stubWindow(false);
      expect(prefersReducedMotion()).toBe(false);
    });
  });

  describe("異常系", () => {
    it("空入力: window が無い（サーバー・ビルド時）なら false", () => {
      vi.stubGlobal("window", undefined);
      expect(prefersReducedMotion()).toBe(false);
    });

    it("空入力: matchMedia が無い環境なら false", () => {
      vi.stubGlobal("window", {});
      expect(prefersReducedMotion()).toBe(false);
    });
  });
});

describe("onReducedMotionChange", () => {
  describe("正常系", () => {
    it("設定が変わると新しい値で呼ばれる", () => {
      const media = stubWindow(false);
      const callback = vi.fn();
      onReducedMotionChange(callback);
      media.fire(true);
      media.fire(false);
      expect(callback.mock.calls).toEqual([[true], [false]]);
    });

    it("戻り値を呼ぶと購読をやめ、その後の変化では呼ばれない", () => {
      const media = stubWindow(false);
      const callback = vi.fn();
      const stop = onReducedMotionChange(callback);
      expect(media.count()).toBe(1);
      stop();
      expect(media.count()).toBe(0);
      media.fire(true);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("空入力: window が無い環境では何もしない関数を返し、例外にしない", () => {
      vi.stubGlobal("window", undefined);
      const stop = onReducedMotionChange(vi.fn());
      expect(() => stop()).not.toThrow();
    });
  });
});
