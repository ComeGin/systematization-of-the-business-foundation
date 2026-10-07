import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRange, TimeZone } from "../../src/services/time.js";

// 日時の変換だけを行う純粋な関数で、上流（サーバ）を呼ばないため「サーバ:」の異常系は置かない

const unix = (iso: string) => Date.parse(iso) / 1000;

describe("TimeZone.format", () => {
  const jst = new TimeZone(9);

  describe("正常系", () => {
    it("Unix 秒を設定した時差の ISO 8601 にする", () => {
      expect(jst.format(unix("2026-09-16T07:00:00+09:00"))).toBe("2026-09-16T07:00:00+09:00");
    });

    it("ISO 文字列も設定した時差に直す", () => {
      expect(jst.format("2026-09-15T22:00:00Z")).toBe("2026-09-16T07:00:00+09:00");
    });

    it("負の時差・30 分単位・45 分単位の時差も ±HH:MM で表す", () => {
      const t = unix("2026-09-16T00:00:00Z");
      expect(new TimeZone(-3.5).format(t)).toBe("2026-09-15T20:30:00-03:30");
      expect(new TimeZone(5.75).format(t)).toBe("2026-09-16T05:45:00+05:45");
      expect(new TimeZone(0).format(t)).toBe("2026-09-16T00:00:00+00:00");
    });

    it("空入力: 0・空文字・null・undefined は null（Chatwoot は未設定を 0 で返す）", () => {
      for (const value of [0, "", null, undefined]) expect(jst.format(value)).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: 負の Unix 秒は null にする", () => {
      expect(jst.format(-1)).toBeNull();
    });

    it("入力: 日時として読めない文字列はそのまま返す", () => {
      expect(jst.format("next monday")).toBe("next monday");
    });

    it("入力: 数値・文字列以外（オブジェクト・真偽値）は null にする", () => {
      expect(jst.format({ at: 1 })).toBeNull();
      expect(jst.format(true)).toBeNull();
    });
  });
});

describe("TimeZone.toUnix", () => {
  const jst = new TimeZone(9);

  describe("正常系", () => {
    it("日付だけなら設定した時差のその日の 0 時にする", () => {
      expect(jst.toUnix("2026-09-16")).toBe(unix("2026-09-16T00:00:00+09:00"));
    });

    it("閏年の 02-29・各月の末日は実在する日付として通す", () => {
      expect(jst.toUnix("2028-02-29")).toBe(unix("2028-02-29T00:00:00+09:00"));
      expect(jst.toUnix("2026-04-30")).toBe(unix("2026-04-30T00:00:00+09:00"));
      expect(jst.toUnix("2026-12-31T23:59:59+09:00")).toBe(unix("2026-12-31T23:59:59+09:00"));
    });

    it("endOfDay=true なら日付をその日の 23:59:59 にする", () => {
      expect(jst.toUnix("2026-09-16", true)).toBe(unix("2026-09-16T23:59:59+09:00"));
    });

    it("時差付きの日時はそのまま Unix 秒にし、endOfDay は効かない", () => {
      expect(jst.toUnix("2026-09-16T10:00:00Z", true)).toBe(unix("2026-09-16T10:00:00Z"));
    });
  });

  describe("異常系", () => {
    it("入力: 月が 13 などの存在しない日付は RangeError にする", () => {
      expect(() => jst.toUnix("2026-13-01")).toThrow(RangeError);
      expect(() => jst.toUnix("2026-13-01")).toThrow("Use a real calendar date in YYYY-MM-DD.");
    });

    it("入力: 日時として読めない文字列は RangeError にする", () => {
      expect(() => jst.toUnix("yesterday")).toThrow("Invalid date 'yesterday'. Use YYYY-MM-DD or an ISO 8601 date-time.");
    });

    it("空入力: 空文字・空白だけは RangeError にする", () => {
      expect(() => jst.toUnix("")).toThrow(RangeError);
      expect(() => jst.toUnix("   ")).toThrow(RangeError);
    });

    // V8 の Date.parse は日を 31 まで受け付けて翌月に繰り越すため、日がその月に実在するかを別に確かめている
    it("入力: 2026-02-30・2026-04-31・平年の 02-29 のような月末を超える日付は、翌月に繰り越さず RangeError にする", () => {
      for (const value of ["2026-02-30", "2026-04-31", "2026-02-29"]) {
        expect(() => jst.toUnix(value)).toThrow(`Invalid date '${value}'. Use a real calendar date in YYYY-MM-DD.`);
      }
    });

    it("入力: 時差付きの日時でも、日付の部分が月末を超えていれば RangeError にする", () => {
      expect(() => jst.toUnix("2026-02-30T09:00:00+09:00")).toThrow(RangeError);
      expect(() => jst.toUnix("2026-04-31T00:00:00Z")).toThrow(RangeError);
    });
  });
});

// Date.parse は時差の無い日時をプロセスのローカル時刻で解釈するため、TZ を UTC にしても +09:00 で解釈されることで確かめる
describe("TimeZone.toUnix: 時差なしの日時", () => {
  const jst = new TimeZone(9);

  beforeEach(() => {
    vi.stubEnv("TZ", "UTC");
  });

  describe("正常系", () => {
    it("時差なしの日時は CHATWOOT_TIMEZONE_OFFSET（日本なら +09:00）で解釈する", () => {
      const expected = Date.parse("2026-09-17T09:00:00+09:00") / 1000;
      expect(jst.toUnix("2026-09-17T09:00")).toBe(expected);
      expect(jst.toUnix("2026-09-17T09:00:00")).toBe(expected);
      expect(jst.toUnix("2026-09-17 09:00:00")).toBe(expected);
      expect(jst.toUnix("2026-09-17T09:00:00.000")).toBe(expected);
    });

    it("時差の付いた日時は、その時差のまま解釈する（設定の時差で上書きしない）", () => {
      expect(jst.toUnix("2026-09-17T00:00:00Z")).toBe(Date.parse("2026-09-17T00:00:00Z") / 1000);
      expect(jst.toUnix("2026-09-17T09:00:00-05:00")).toBe(Date.parse("2026-09-17T14:00:00Z") / 1000);
    });
  });

  describe("異常系", () => {
    it("入力: 時差なしでも、存在しない日付は RangeError にする", () => {
      expect(() => jst.toUnix("2026-02-30T09:00")).toThrow(RangeError);
    });
  });
});

describe("resolveRange", () => {
  const jst = new TimeZone(9);

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("正常系", () => {
    it("空入力: since・until を省略すると「今」までの直近 30 日にする", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
      const now = unix("2026-09-16T00:00:00Z");
      expect(resolveRange(jst, undefined, undefined)).toEqual({ since: now - 30 * 86_400, until: now });
    });

    it("空入力: 空文字の since・until は省略と同じに扱う", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
      const now = unix("2026-09-16T00:00:00Z");
      expect(resolveRange(jst, "", "")).toEqual({ since: now - 30 * 86_400, until: now });
    });

    it("until を日付で指定するとその日の終わりまでを含める", () => {
      expect(resolveRange(jst, "2026-09-01", "2026-09-30")).toEqual({
        since: unix("2026-09-01T00:00:00+09:00"),
        until: unix("2026-09-30T23:59:59+09:00"),
      });
    });

    it("since だけ省略すると until の 30 日前からにする", () => {
      const until = unix("2026-09-30T23:59:59+09:00");
      expect(resolveRange(jst, undefined, "2026-09-30")).toEqual({ since: until - 30 * 86_400, until });
    });

    it("同じ日を since・until に指定すると、その 1 日を範囲にする", () => {
      expect(resolveRange(jst, "2026-09-15", "2026-09-15")).toEqual({
        since: unix("2026-09-15T00:00:00+09:00"),
        until: unix("2026-09-15T23:59:59+09:00"),
      });
    });
  });

  describe("異常系", () => {
    it("入力: since が until 以降なら RangeError にする", () => {
      expect(() => resolveRange(jst, "2026-10-01", "2026-09-30")).toThrow("since must be earlier than until.");
    });

    it("入力: 読めない日付は RangeError にする", () => {
      expect(() => resolveRange(jst, "last week", undefined)).toThrow(RangeError);
      expect(() => resolveRange(jst, undefined, "2026-13-01")).toThrow(RangeError);
    });
  });
});
