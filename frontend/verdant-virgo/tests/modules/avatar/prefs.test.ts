import { afterEach, describe, expect, it, vi } from "vitest";
import { readCollapsed, readGreeted, writeCollapsed, writeGreeted } from "@/modules/avatar/lib/prefs";

// アバターの記憶（sessionStorage）。window を差し替え、sessionStorage は Map で作った偽物にする。

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new Error("SecurityError");
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readCollapsed／writeCollapsed", () => {
  describe("正常系", () => {
    it("書いて読める（true → false に戻せる）", () => {
      const sessionStorage = fakeStorage();
      vi.stubGlobal("window", { sessionStorage });
      writeCollapsed(true);
      expect(readCollapsed()).toBe(true);
      expect(sessionStorage.getItem("avatar:collapsed")).toBe("true");
      writeCollapsed(false);
      expect(readCollapsed()).toBe(false);
      expect(sessionStorage.getItem("avatar:collapsed")).toBeNull();
    });
  });
  describe("異常系", () => {
    it("サーバ: sessionStorage が throw しても false を返し、書き込みは黙って捨てる", () => {
      vi.stubGlobal("window", { sessionStorage: throwingStorage() });
      expect(() => writeCollapsed(true)).not.toThrow();
      expect(readCollapsed()).toBe(false);
    });
    it("入力: 知らない値が入っていれば false", () => {
      const sessionStorage = fakeStorage();
      sessionStorage.setItem("avatar:collapsed", "yes");
      vi.stubGlobal("window", { sessionStorage });
      expect(readCollapsed()).toBe(false);
    });
    it("空入力: 何も保存されていなければ false", () => {
      vi.stubGlobal("window", { sessionStorage: fakeStorage() });
      expect(readCollapsed()).toBe(false);
    });
  });
});

describe("readGreeted／writeGreeted", () => {
  describe("正常系", () => {
    it("書いて読める", () => {
      const sessionStorage = fakeStorage();
      vi.stubGlobal("window", { sessionStorage });
      writeGreeted();
      expect(readGreeted()).toBe(true);
      expect(sessionStorage.getItem("avatar:greeted")).toBe("true");
    });
  });
  describe("異常系", () => {
    it("サーバ: sessionStorage が throw しても false を返し、書き込みは黙って捨てる", () => {
      vi.stubGlobal("window", { sessionStorage: throwingStorage() });
      expect(() => writeGreeted()).not.toThrow();
      expect(readGreeted()).toBe(false);
    });
    it("空入力: 何も保存されていなければ false", () => {
      vi.stubGlobal("window", { sessionStorage: fakeStorage() });
      expect(readGreeted()).toBe(false);
    });
  });
});
