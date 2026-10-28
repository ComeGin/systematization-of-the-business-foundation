import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchYield, YIELD_SETTLE_MS } from "@/modules/avatar/lib/yield";
import { DURATION } from "@/modules/motion/lib/tokens";

// 模型が見えている間、画面の端のアバターを引っ込める判定（H-13。代表のアバターが同じ画面に 2 人いない）。
// IntersectionObserver はモックし、見えた・外れたを手で起こす。出入りの判定に settleMs の遅延を置き、素早く行き来しても点滅させない。

type Callback = (entries: { isIntersecting: boolean }[]) => void;
let observers: { cb: Callback; observed: Element[]; disconnected: boolean }[] =
  [];

class FakeObserver {
  private record: { cb: Callback; observed: Element[]; disconnected: boolean };
  constructor(cb: Callback) {
    this.record = { cb, observed: [], disconnected: false };
    observers.push(this.record);
  }
  observe(el: Element) {
    this.record.observed.push(el);
  }
  disconnect() {
    this.record.disconnected = true;
  }
}

const fire = (isIntersecting: boolean) =>
  observers.forEach((o) => !o.disconnected && o.cb([{ isIntersecting }]));
const el = {} as Element;

beforeEach(() => {
  observers = [];
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchYield", () => {
  describe("正常系", () => {
    it("最初の通知（開いた時点の状態）は遅延なしで確定する（読み込みのたびに端のアバターが一瞬出て引っ込むのを避ける）", () => {
      const onChange = vi.fn();
      watchYield(el, onChange, { settleMs: 300 });
      fire(true);
      expect(onChange).toHaveBeenLastCalledWith(true);
    });

    it("2 回目以降の変化は settleMs の後に確定する", () => {
      const onChange = vi.fn();
      watchYield(el, onChange, { settleMs: 300 });
      fire(false);
      fire(true);
      vi.advanceTimersByTime(299);
      expect(onChange).not.toHaveBeenCalledWith(true);
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenLastCalledWith(true);
    });

    it("外れたら settleMs の後に false", () => {
      const onChange = vi.fn();
      watchYield(el, onChange, { settleMs: 300 });
      fire(true);
      fire(false);
      vi.advanceTimersByTime(299);
      expect(onChange.mock.calls).toEqual([[true]]);
      vi.advanceTimersByTime(1);
      expect(onChange.mock.calls).toEqual([[true], [false]]);
    });

    it("しきい値の前後を素早く行き来しても、最初の確定のあとは通知しない（点滅しない）", () => {
      const onChange = vi.fn();
      watchYield(el, onChange, { settleMs: 300 });
      fire(true);
      vi.advanceTimersByTime(100);
      fire(false);
      vi.advanceTimersByTime(100);
      fire(true);
      vi.advanceTimersByTime(300);
      expect(onChange.mock.calls).toEqual([[true]]);
    });

    it("戻り値で監視をやめる（その後の変化は通知しない）", () => {
      const onChange = vi.fn();
      const stop = watchYield(el, onChange, { settleMs: 300 });
      stop();
      expect(observers[0].disconnected).toBe(true);
      fire(true);
      vi.advanceTimersByTime(300);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("入力: IntersectionObserver が無い環境では常に false（端のアバターを隠さない）", () => {
      vi.stubGlobal("IntersectionObserver", undefined);
      const onChange = vi.fn();
      watchYield(el, onChange, { settleMs: 300 });
      vi.advanceTimersByTime(1000);
      expect(onChange).not.toHaveBeenCalledWith(true);
    });
  });

  it("空入力: settleMs を省くと YIELD_SETTLE_MS（DURATION.medium）", () => {
    expect(YIELD_SETTLE_MS).toBe(DURATION.medium);
    const onChange = vi.fn();
    watchYield(el, onChange);
    fire(false);
    fire(true);
    vi.advanceTimersByTime(YIELD_SETTLE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});
