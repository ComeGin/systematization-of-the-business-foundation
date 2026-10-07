import { afterEach, describe, expect, it, vi } from "vitest";
import { auditDayKey, jstDate, jstDayStart, toIsoJst } from "../src/time.js";

// 引数を省いた呼び出し（現在時刻）はシステム時刻を偽物にして確かめる
afterEach(() => {
  vi.useRealTimers();
});

function freezeAt(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("toIsoJst", () => {
  describe("正常系", () => {
    it("+09:00 付きの ISO 8601 にし、同じ瞬間を指す", () => {
      const date = new Date("2026-10-04T23:30:00.123Z");
      const iso = toIsoJst(date);
      expect(iso).toBe("2026-10-05T08:30:00.123+09:00");
      expect(Date.parse(iso)).toBe(date.getTime());
    });

    it("空入力: 引数を省く（undefined）とシステム時刻を使う", () => {
      freezeAt("2026-10-05T00:00:00Z");
      expect(toIsoJst()).toBe("2026-10-05T09:00:00.000+09:00");
      expect(toIsoJst(undefined)).toBe("2026-10-05T09:00:00.000+09:00");
    });

    it("同じタイムゾーン表記どうしなら文字列の大小 = 時刻の大小（SQLite の比較に使う前提）", () => {
      const a = toIsoJst(new Date("2026-10-04T14:59:59.999Z"));
      const b = toIsoJst(new Date("2026-10-04T15:00:00.000Z"));
      expect(a < b).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: 不正な Date（Invalid Date）は RangeError を投げる（不正な時刻を記録しない）", () => {
      expect(() => toIsoJst(new Date("not a date"))).toThrow(RangeError);
    });
  });
});

describe("jstDate", () => {
  describe("正常系", () => {
    it("UTC の 15:00 で JST の日付が変わる", () => {
      expect(jstDate(new Date("2026-10-04T14:59:59.999Z"))).toBe("2026-10-04");
      expect(jstDate(new Date("2026-10-04T15:00:00.000Z"))).toBe("2026-10-05");
    });

    it("空入力: 引数を省くとシステム時刻の JST の日付", () => {
      freezeAt("2026-10-04T15:00:00Z");
      expect(jstDate()).toBe("2026-10-05");
    });
  });

  describe("異常系", () => {
    it("入力: 不正な Date は RangeError を投げる", () => {
      expect(() => jstDate(new Date(Number.NaN))).toThrow(RangeError);
    });
  });
});

describe("jstDayStart", () => {
  describe("正常系", () => {
    it("JST の 0 時（UTC では前日の 15:00）", () => {
      expect(jstDayStart(new Date("2026-10-05T03:00:00Z")).toISOString()).toBe("2026-10-04T15:00:00.000Z");
      expect(jstDayStart(new Date("2026-10-04T15:00:00Z")).toISOString()).toBe("2026-10-04T15:00:00.000Z");
    });

    it("空入力: 引数を省くとシステム時刻の日の 0 時（JST）", () => {
      freezeAt("2026-10-05T03:00:00Z");
      expect(jstDayStart().toISOString()).toBe("2026-10-04T15:00:00.000Z");
    });
  });

  describe("異常系", () => {
    it("入力: 不正な Date は RangeError を投げる", () => {
      expect(() => jstDayStart(new Date("x"))).toThrow(RangeError);
    });
  });
});

describe("auditDayKey", () => {
  describe("正常系", () => {
    it("<西暦>-<月日>（JST）", () => {
      expect(auditDayKey(new Date("2026-10-04T15:00:00Z"))).toBe("2026-1005");
      expect(auditDayKey(new Date("2026-12-31T14:59:59Z"))).toBe("2026-1231");
      expect(auditDayKey(new Date("2026-12-31T15:00:00Z"))).toBe("2027-0101");
    });

    it("空入力: 引数を省くとシステム時刻の日（JST）", () => {
      freezeAt("2026-12-31T15:00:00Z");
      expect(auditDayKey()).toBe("2027-0101");
    });
  });

  describe("異常系", () => {
    it("入力: 不正な Date は RangeError を投げる（壊れた監査 ID を作らない）", () => {
      expect(() => auditDayKey(new Date(Number.NaN))).toThrow(RangeError);
    });
  });
});
