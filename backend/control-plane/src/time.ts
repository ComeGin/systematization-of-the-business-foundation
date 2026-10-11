// 日時は ISO 8601（タイムゾーン付き）で持つ。日本時間は夏時間が無いため +09:00 固定で足りる。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const TIMEZONE = "Asia/Tokyo";

export function toIsoJst(date: Date = new Date()): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** JST の日付（YYYY-MM-DD） */
export function jstDate(date: Date = new Date()): string {
  return toIsoJst(date).slice(0, 10);
}

/** その日（JST）の 0 時 */
export function jstDayStart(date: Date = new Date()): Date {
  return new Date(`${jstDate(date)}T00:00:00+09:00`);
}

/** AUD-<西暦>-<月日> の「<西暦>-<月日>」部分（例 2026-1004） */
export function auditDayKey(date: Date = new Date()): string {
  const day = jstDate(date);
  return `${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}`;
}
