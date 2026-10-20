import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_AFTER_MS } from "@/modules/avatar/lib/emotes";
import { watchTriggers } from "@/modules/avatar/lib/triggers";
import type { AvatarTrigger } from "@/modules/avatar/lib/types";

// watchTriggers（合図の検知）。ブラウザの document・window・IntersectionObserver は小さな偽物にする。
// 見るのは「受け手が受理しなかった合図を消費しない」こと（R18）: 料金の節は受理されるまで見張り続け、idle は受理されるまで間を置いて出し直す。

type Listener = (event: Event) => void;

class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: Partial<Event> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }
}

let observers: FakeObserver[] = [];

class FakeObserver {
  disconnected = false;
  constructor(public callback: (entries: { isIntersecting: boolean }[]) => void) {
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  /** 料金の節が画面に入った・出た */
  fire(isIntersecting: boolean) {
    if (!this.disconnected) this.callback([{ isIntersecting }]);
  }
}

function setup({ pricing = false, formSuccess = false } = {}) {
  const doc = new FakeTarget() as FakeTarget & {
    querySelector(selector: string): object | null;
    querySelectorAll(selector: string): object[];
  };
  doc.querySelector = (selector) => (formSuccess && selector.includes("form-success") ? {} : null);
  doc.querySelectorAll = (selector) => (pricing && selector.includes("pricing") ? [{}] : []);
  const win = new FakeTarget() as FakeTarget & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  win.setTimeout = ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout;
  win.clearTimeout = ((id: number) => clearTimeout(id)) as typeof clearTimeout;
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("Element", class {});
  return { doc, win };
}

beforeEach(() => {
  observers = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watchTriggers", () => {
  describe("正常系", () => {
    it("開始時に arrive。完了画面の印があれば form-success", () => {
      setup();
      const seen: AvatarTrigger[] = [];
      watchTriggers("calm", (t) => (seen.push(t), true))();
      setup({ formSuccess: true });
      watchTriggers("calm", (t) => (seen.push(t), true))();
      expect(seen).toEqual(["arrive", "form-success"]);
    });
    it("料金の節が入って受理されたら、見張りをやめる（1 ページ 1 回）", () => {
      setup({ pricing: true });
      const seen: AvatarTrigger[] = [];
      const stop = watchTriggers("vivid", (t) => (seen.push(t), true));
      observers[0]!.fire(true);
      expect(seen).toEqual(["arrive", "reach-pricing"]);
      expect(observers[0]!.disconnected).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(seen.filter((t) => t === "reach-pricing")).toHaveLength(1);
      stop();
    });
    it("A は何もしない間が続くと idle を出し、受理されたら次は IDLE_AFTER_MS の後", () => {
      setup();
      const seen: AvatarTrigger[] = [];
      const stop = watchTriggers("vivid", (t) => (seen.push(t), true));
      vi.advanceTimersByTime(IDLE_AFTER_MS);
      expect(seen).toEqual(["arrive", "idle"]);
      vi.advanceTimersByTime(IDLE_AFTER_MS - 1);
      expect(seen.filter((t) => t === "idle")).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(seen.filter((t) => t === "idle")).toHaveLength(2);
      stop();
    });
  });
  describe("異常系", () => {
    it("入力: 料金の節で受理されなかったら（一時停止・再生中）見張りを続け、画面にある間は出し直す", () => {
      setup({ pricing: true });
      let accept = false;
      const seen: AvatarTrigger[] = [];
      const stop = watchTriggers("vivid", (t) => (seen.push(t), t === "arrive" || accept));
      observers[0]!.fire(true);
      expect(observers[0]!.disconnected).toBe(false);
      accept = true;
      vi.advanceTimersByTime(1_000);
      expect(seen.filter((t) => t === "reach-pricing")).toHaveLength(2);
      expect(observers[0]!.disconnected).toBe(true);
      stop();
    });
    it("入力: 受理されないまま節が画面から出たら出し直さず、また入ったら出す", () => {
      setup({ pricing: true });
      let accept = false;
      const seen: AvatarTrigger[] = [];
      const stop = watchTriggers("vivid", (t) => (seen.push(t), t === "arrive" || accept));
      observers[0]!.fire(true);
      observers[0]!.fire(false);
      vi.advanceTimersByTime(5_000);
      expect(seen.filter((t) => t === "reach-pricing")).toHaveLength(1);
      accept = true;
      observers[0]!.fire(true);
      expect(seen.filter((t) => t === "reach-pricing")).toHaveLength(2);
      expect(observers[0]!.disconnected).toBe(true);
      stop();
    });
    it("入力: idle が受理されなかったら、操作が無い限り少し後に出し直す", () => {
      setup();
      let accept = false;
      const seen: AvatarTrigger[] = [];
      const stop = watchTriggers("vivid", (t) => (seen.push(t), t === "arrive" || accept));
      vi.advanceTimersByTime(IDLE_AFTER_MS);
      expect(seen.filter((t) => t === "idle")).toHaveLength(1);
      accept = true;
      vi.advanceTimersByTime(1_000);
      expect(seen.filter((t) => t === "idle")).toHaveLength(2);
      stop();
    });
    it("入力: B（calm）は idle を出さない", () => {
      setup();
      const seen: AvatarTrigger[] = [];
      const stop = watchTriggers("calm", (t) => (seen.push(t), true));
      vi.advanceTimersByTime(IDLE_AFTER_MS * 3);
      expect(seen).toEqual(["arrive"]);
      stop();
    });
    it("入力: B（calm）は料金の節を監視しない（受理されない合図を 1 秒ごとに出し直し続けない）", () => {
      setup({ pricing: true });
      const seen: AvatarTrigger[] = [];
      // calm の表に reach-pricing は無いので、受け手はいつも受理しない
      const stop = watchTriggers("calm", (t) => (seen.push(t), t === "arrive"));
      expect(observers).toHaveLength(0);
      vi.advanceTimersByTime(5_000);
      expect(seen).toEqual(["arrive"]);
      stop();
    });
    it("空入力: 料金の節が無いページでは IntersectionObserver を作らない", () => {
      setup();
      const stop = watchTriggers("vivid", () => true);
      expect(observers).toHaveLength(0);
      stop();
    });
  });
});
