// 基準 D の例外: テスト対象そのものが SQL のため、node:sqlite は差し替えず :memory: の実 SQLite で確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KvStore } from "../../src/store/kv.js";
import { memoryE15 } from "../helpers/store.js";

describe("KvStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("正常系", () => {
    it("無いキーは null", () => {
      expect(new KvStore(memoryE15()).get("missing")).toBeNull();
    });

    it("set したものを get で返し、同じキーは上書きして updated_at（JST）も更新する", () => {
      const db = memoryE15();
      const kv = new KvStore(db);
      vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
      kv.set("cursor", "a");
      vi.setSystemTime(new Date("2026-10-05T01:00:00Z"));
      kv.set("cursor", "b");
      expect(kv.get("cursor")).toBe("b");
      expect(db.prepare("SELECT count(*) AS n, max(updated_at) AS at FROM kv").get()).toEqual({
        n: 1,
        at: "2026-10-05T10:00:00.000+09:00",
      });
    });

    it("空入力: 空文字も値として保存する（未設定の null と区別する）", () => {
      const kv = new KvStore(memoryE15());
      kv.set("k", "");
      expect(kv.get("k")).toBe("");
    });

    it("空入力: 空文字のキーも 1 つのキーとして扱い、未設定なら null", () => {
      const kv = new KvStore(memoryE15());
      expect(kv.get("")).toBeNull();
      kv.set("", "v");
      expect(kv.get("")).toBe("v");
      expect(kv.get("other")).toBeNull();
    });
  });

  describe("異常系", () => {
    it("サーバ: DB が閉じていれば get・set は例外を投げる（握りつぶして null にしない）", () => {
      const db = memoryE15();
      const kv = new KvStore(db);
      db.close();
      expect(() => kv.get("k")).toThrow();
      expect(() => kv.set("k", "v")).toThrow();
    });
  });
});
