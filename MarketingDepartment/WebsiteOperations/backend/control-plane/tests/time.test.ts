import { afterEach, describe, expect, it, vi } from "vitest";
import { auditDayKey, jstDate, jstDayStart, toIsoJst } from "../src/time.js";

describe("toIsoJst", () => {
  it("+09:00 付きの ISO 8601 にし、同じ瞬間を指す", () => {
    const date = new Date("2026-10-04T23:30:00.123Z");
    const iso = toIsoJst(date);
    expect(iso).toBe("2026-10-05T08:30:00.123+09:00");
    expect(Date.parse(iso)).toBe(date.getTime());
  });

  describe("引数を省くと現在時刻", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("システム時刻を使う", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
      expect(toIsoJst()).toBe("2026-10-05T09:00:00.000+09:00");
    });
  });

  it("同じタイムゾーン表記どうしなら文字列の大小 = 時刻の大小（SQLite の比較に使う前提）", () => {
    const a = toIsoJst(new Date("2026-10-04T14:59:59.999Z"));
    const b = toIsoJst(new Date("2026-10-04T15:00:00.000Z"));
    expect(a < b).toBe(true);
  });
});

describe("jstDate / jstDayStart / auditDayKey", () => {
  it("UTC の 15:00 で JST の日付が変わる", () => {
    expect(jstDate(new Date("2026-10-04T14:59:59.999Z"))).toBe("2026-10-04");
    expect(jstDate(new Date("2026-10-04T15:00:00.000Z"))).toBe("2026-10-05");
  });

  it("jstDayStart は JST の 0 時（UTC では前日の 15:00）", () => {
    expect(jstDayStart(new Date("2026-10-05T03:00:00Z")).toISOString()).toBe("2026-10-04T15:00:00.000Z");
    expect(jstDayStart(new Date("2026-10-04T15:00:00Z")).toISOString()).toBe("2026-10-04T15:00:00.000Z");
  });

  it("auditDayKey は <西暦>-<月日>（JST）", () => {
    expect(auditDayKey(new Date("2026-10-04T15:00:00Z"))).toBe("2026-1005");
    expect(auditDayKey(new Date("2026-12-31T14:59:59Z"))).toBe("2026-1231");
    expect(auditDayKey(new Date("2026-12-31T15:00:00Z"))).toBe("2027-0101");
  });
});
