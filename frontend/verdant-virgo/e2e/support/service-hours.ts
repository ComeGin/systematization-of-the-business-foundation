// 受付時間外（0〜8 時 JST。src/modules/service-hours）に、テストのページの時計を日中へずらす（2026-11-25）。
//
// 公開サイトは 0〜8 時にフォームの送信ボタンを押せなくし、チャットのウィジェットを読み込まない。月曜 01:15 の weekly-a11y や
// 夜に実行した E2E が、この時間に「送信を押す」「チャットを開く」テストで落ちないよう、e2e/a11y と e2e/flows の共通の fixture が
// すべてのページでこれを呼ぶ。実際の時刻が受付時間内なら何もしない（昼に実行したときの動きを変えない）。
//
// setSystemTime は時計を進め続ける（setFixedTime のように止めない）。タイマー（フォームの 10 秒のタイムアウトなど）もそのまま動く。
// 受付時間外そのものを確かめる spec（e2e/a11y/service-hours.spec.ts）と、時刻を決める spec（atelier.spec.ts の setFixedTime、
// booking.spec.ts の install）は、その spec の中で時計を設定し直す（後から呼んだものが勝つ）。
import type { Clock } from "@playwright/test";
import { isOutsideServiceHours } from "../../src/modules/service-hours";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 受付時間外なら、同じ日（JST）の 12:00 の時刻を返す。受付時間内なら null */
export function daytimeIfClosed(now: Date = new Date()): Date | null {
  if (!isOutsideServiceHours(now)) return null;
  const jstDay = new Date(now.getTime() + JST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  return new Date(`${jstDay}T12:00:00+09:00`);
}

/** 時計を受付時間内にする（受付時間外に実行したときだけ。ページを開く前に、BrowserContext か Page を渡して呼ぶ） */
export async function keepServiceHoursOpen(target: {
  clock: Clock;
}): Promise<void> {
  const daytime = daytimeIfClosed();
  if (daytime) await target.clock.setSystemTime(daytime);
}

/** 受付時間外を確かめる spec 用。JST の指定の時刻（"02:00" か "07:59:30"）の、今日（JST）の日時 */
export function jstToday(time: string, now: Date = new Date()): Date {
  const jstDay = new Date(now.getTime() + JST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  const hms = time.split(":").length === 2 ? `${time}:00` : time;
  return new Date(`${jstDay}T${hms}+09:00`);
}
