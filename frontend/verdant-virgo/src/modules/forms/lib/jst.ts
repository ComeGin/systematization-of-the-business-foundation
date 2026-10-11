// JST の日時（同意日時 privacy_consent_at と、二重送信のキーの日付。DD-02 の 5.3・5 節の冪等キー）。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(date: Date): string[] {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return shifted.toISOString().split(/[T.]/); // [YYYY-MM-DD, HH:mm:ss, ...]
}

/** 例 2026-10-09T13:05:00+09:00 */
export function jstIsoString(date = new Date()): string {
  const [day, time] = jstParts(date);
  return `${day}T${time}+09:00`;
}

/** 例 2026-10-09 */
export function jstDate(date = new Date()): string {
  return jstParts(date)[0];
}
