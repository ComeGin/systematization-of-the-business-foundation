import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCROLL_SETTLE_MS,
  watchScrollAway,
} from "@/modules/avatar/lib/scroll-away";
import { DURATION } from "@/modules/motion/lib/tokens";

// watchScrollAway（Mobile でスクロールしている間だけアバターを画面の外へ逃がす。Task 10b）。
// window・document は小さな偽物にし、時刻はフェイクタイマーで進める。

type Listener = (event: Event) => void;

class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  options = new Map<string, AddEventListenerOptions | undefined>();
  addEventListener(
    type: string,
    listener: Listener,
    options?: AddEventListenerOptions,
  ) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    this.options.set(type, options);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({} as Event);
  }
}

function setup() {
  const win = new FakeTarget() as FakeTarget & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  win.setTimeout = ((fn: () => void, ms: number) =>
    setTimeout(fn, ms)) as typeof setTimeout;
  win.clearTimeout = ((id: number) => clearTimeout(id)) as typeof clearTimeout;
  const doc = new FakeTarget();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  return { win, doc };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchScrollAway", () => {
  describe("正常系", () => {
    it("止まったと見なす間はトークンの large（600ms）", () => {
      expect(SCROLL_SETTLE_MS).toBe(DURATION.large);
      expect(SCROLL_SETTLE_MS).toBe(600);
    });

    it("スクロールで逃がし、止まって 600ms 経ったら戻す", () => {
      const { win } = setup();
      const seen: boolean[] = [];
      watchScrollAway({
        canHide: () => true,
        onChange: (away) => seen.push(away),
      });
      win.dispatch("scroll");
      expect(seen).toEqual([true]);
      vi.advanceTimersByTime(SCROLL_SETTLE_MS - 1);
      expect(seen).toEqual([true]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual([true, false]);
    });

    it("スクロールが続く間は戻さず、逃がす合図も 1 回だけ（最後のスクロールから 600ms）", () => {
      const { win } = setup();
      const seen: boolean[] = [];
      watchScrollAway({
        canHide: () => true,
        onChange: (away) => seen.push(away),
      });
      for (let i = 0; i < 10; i++) {
        win.dispatch("scroll");
        vi.advanceTimersByTime(200);
      }
      expect(seen).toEqual([true]);
      // 最後のスクロールから 200ms 経っている。残りの 400ms で戻る
      vi.advanceTimersByTime(SCROLL_SETTLE_MS - 200 - 1);
      expect(seen).toEqual([true]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual([true, false]);
    });

    it("スクロールの監視は passive", () => {
      const { win } = setup();
      watchScrollAway({ canHide: () => true, onChange: () => {} });
      expect(win.options.get("scroll")?.passive).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: 隠してはいけない間（アバターのボタンにフォーカスがある）はスクロールしても逃がさない", () => {
      const { win } = setup();
      const seen: boolean[] = [];
      watchScrollAway({
        canHide: () => false,
        onChange: (away) => seen.push(away),
      });
      win.dispatch("scroll");
      vi.advanceTimersByTime(SCROLL_SETTLE_MS * 2);
      expect(seen).toEqual([]);
    });

    it("入力: 逃がしている間にフォーカスがアバターの中へ来たら、止まるのを待たずに戻す", () => {
      const { win, doc } = setup();
      const seen: boolean[] = [];
      let focusInside = false;
      watchScrollAway({
        canHide: () => !focusInside,
        onChange: (away) => seen.push(away),
      });
      win.dispatch("scroll");
      focusInside = true;
      doc.dispatch("focusin");
      expect(seen).toEqual([true, false]);
      // スクロールが続いても、フォーカスがある間は逃がさない
      win.dispatch("scroll");
      vi.advanceTimersByTime(SCROLL_SETTLE_MS);
      expect(seen).toEqual([true, false]);
      // フォーカスが外れた後のスクロールでは、また逃がす
      focusInside = false;
      win.dispatch("scroll");
      expect(seen).toEqual([true, false, true]);
    });

    it("入力: 止めた後はスクロールしても何もせず、待っていたタイマーも捨てる", () => {
      const { win } = setup();
      const seen: boolean[] = [];
      const stop = watchScrollAway({
        canHide: () => true,
        onChange: (away) => seen.push(away),
      });
      win.dispatch("scroll");
      stop();
      vi.advanceTimersByTime(SCROLL_SETTLE_MS * 2);
      win.dispatch("scroll");
      expect(seen).toEqual([true]);
    });

    it("空入力: スクロールもフォーカスも無ければ何も呼ばない", () => {
      const { doc } = setup();
      const seen: boolean[] = [];
      watchScrollAway({
        canHide: () => true,
        onChange: (away) => seen.push(away),
      });
      doc.dispatch("focusin");
      vi.advanceTimersByTime(SCROLL_SETTLE_MS * 2);
      expect(seen).toEqual([]);
    });
  });
});
