import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRange, TimeZone } from "../../src/services/time.js";

const unix = (iso: string) => Date.parse(iso) / 1000;

describe("TimeZone.format", () => {
  const jst = new TimeZone(9);

  it("Unix 秒を設定した時差の ISO 8601 にする", () => {
    expect(jst.format(unix("2026-09-16T07:00:00+09:00"))).toBe("2026-09-16T07:00:00+09:00");
  });

  it("ISO 文字列も設定した時差に直す", () => {
    expect(jst.format("2026-09-15T22:00:00Z")).toBe("2026-09-16T07:00:00+09:00");
  });

  it("0 以下・空文字・null・undefined は null（Chatwoot は未設定を 0 で返す）", () => {
    for (const value of [0, -1, "", null, undefined]) expect(jst.format(value)).toBeNull();
  });

  it("日時として読めない文字列はそのまま返す", () => {
    expect(jst.format("next monday")).toBe("next monday");
  });

  it("負の時差・30 分単位・45 分単位の時差も ±HH:MM で表す", () => {
    const t = unix("2026-09-16T00:00:00Z");
    expect(new TimeZone(-3.5).format(t)).toBe("2026-09-15T20:30:00-03:30");
    expect(new TimeZone(5.75).format(t)).toBe("2026-09-16T05:45:00+05:45");
    expect(new TimeZone(0).format(t)).toBe("2026-09-16T00:00:00+00:00");
  });
});

describe("TimeZone.toUnix", () => {
  const jst = new TimeZone(9);

  it("日付だけなら設定した時差のその日の 0 時にする", () => {
    expect(jst.toUnix("2026-09-16")).toBe(unix("2026-09-16T00:00:00+09:00"));
  });

  it("endOfDay=true なら日付をその日の 23:59:59 にする", () => {
    expect(jst.toUnix("2026-09-16", true)).toBe(unix("2026-09-16T23:59:59+09:00"));
  });

  it("時差付きの日時はそのまま Unix 秒にし、endOfDay は効かない", () => {
    expect(jst.toUnix("2026-09-16T10:00:00Z", true)).toBe(unix("2026-09-16T10:00:00Z"));
  });

  it("月が 13 などの存在しない日付は RangeError にする", () => {
    expect(() => jst.toUnix("2026-13-01")).toThrow(RangeError);
    expect(() => jst.toUnix("2026-13-01")).toThrow("Use a real calendar date in YYYY-MM-DD.");
  });

  it("日時として読めない文字列は RangeError にする", () => {
    expect(() => jst.toUnix("yesterday")).toThrow("Invalid date 'yesterday'. Use YYYY-MM-DD or an ISO 8601 date-time.");
  });

  it.todo(
    "不具合候補: 2026-02-30・2026-04-31 のような月末を超える日付が RangeError にならず翌月に繰り越される（V8 の Date.parse は日を 31 まで受け付ける。src/services/time.ts:41-43 のコメントの意図と異なる）",
  );
  it.todo(
    "不具合候補: 時差なしの日時（例 2026-09-17T09:00）は CHATWOOT_TIMEZONE_OFFSET ではなくプロセスのローカル時刻で解釈される（DateTimeSchema が許可している。src/services/time.ts:46）",
  );
});

describe("resolveRange", () => {
  const jst = new TimeZone(9);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("省略時は「今」までの直近 30 日にする", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
    const now = unix("2026-09-16T00:00:00Z");
    expect(resolveRange(jst, undefined, undefined)).toEqual({ since: now - 30 * 86_400, until: now });
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

  it("since が until 以降なら RangeError にする", () => {
    expect(() => resolveRange(jst, "2026-10-01", "2026-09-30")).toThrow("since must be earlier than until.");
  });
});
