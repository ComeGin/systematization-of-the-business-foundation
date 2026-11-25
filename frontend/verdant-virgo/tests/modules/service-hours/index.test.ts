import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOutsideServiceHours,
  SERVICE_CLOSED_HOURS_JST,
} from "@/modules/service-hours";

// isOutsideServiceHours（受付時間外〈0〜8 時 JST〉の判定。2026-11-25。本番の Chatwoot・Mautic は 0 時〜7 時 50 分に止まる）。
// 端末のタイムゾーンに関係なく JST で判定することを、UTC の時刻で渡して確かめる。
const at = (iso: string) => new Date(iso);

afterEach(() => {
  vi.useRealTimers();
});

describe("isOutsideServiceHours", () => {
  describe("正常系", () => {
    it("受付時間外は JST の 0 時以上 8 時未満", () => {
      expect(SERVICE_CLOSED_HOURS_JST).toEqual({ start: 0, end: 8 });
    });

    it.each([
      ["0:00 ちょうど", "2026-11-25T00:00:00+09:00"],
      ["2:00", "2026-11-25T02:00:00+09:00"],
      ["7:50（ECS の再開の時刻。まだ起動待ち）", "2026-11-25T07:50:00+09:00"],
      ["7:59:59", "2026-11-25T07:59:59+09:00"],
    ])("JST の %s は受付時間外", (_label, iso) => {
      expect(isOutsideServiceHours(at(iso))).toBe(true);
    });

    it.each([
      ["8:00 ちょうど", "2026-11-25T08:00:00+09:00"],
      ["12:00", "2026-11-25T12:00:00+09:00"],
      ["23:59:59", "2026-11-25T23:59:59+09:00"],
    ])("JST の %s は受付時間内", (_label, iso) => {
      expect(isOutsideServiceHours(at(iso))).toBe(false);
    });

    it("UTC で書いた同じ時刻でも JST で判定する（UTC 15:30 は JST 0:30 で受付時間外、UTC 23:30 は JST 8:30 で受付時間内）", () => {
      expect(isOutsideServiceHours(at("2026-11-24T15:30:00Z"))).toBe(true);
      expect(isOutsideServiceHours(at("2026-11-24T23:30:00Z"))).toBe(false);
    });

    it("空入力: 引数を省略すると今の時刻で判定する", () => {
      vi.useFakeTimers();
      vi.setSystemTime(at("2026-11-25T03:00:00+09:00"));
      expect(isOutsideServiceHours()).toBe(true);
      vi.setSystemTime(at("2026-11-25T09:00:00+09:00"));
      expect(isOutsideServiceHours()).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 不正な日時（Invalid Date）は受付時間外にしない（NaN の時は範囲に入らない）", () => {
      expect(isOutsideServiceHours(new Date(Number.NaN))).toBe(false);
    });
  });
});
