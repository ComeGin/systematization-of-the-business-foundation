// 改善ループの周（14 日）の暦。起点は CONTROL_CYCLE_ANCHOR（JST の月曜の日付）。
// 周の ID は C-<その周の起点の日付>、周の何日目かは 0〜13。日本時間は夏時間が無いため、日数は 24 時間ごとの割り算で足りる。
import type { CycleId } from "../contract.js";
import { jstDate } from "../time.js";

export const CYCLE_LENGTH_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHOR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD の日の 0 時（JST）。暦に無い日付（2026-02-30 など）は null */
function jstMidnight(day: string): Date | null {
  if (!ANCHOR_PATTERN.test(day)) return null;
  const date = new Date(`${day}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime()) || jstDate(date) !== day) return null;
  return date;
}

/** YYYY-MM-DD が実在する日付で、JST で月曜か（CONTROL_CYCLE_ANCHOR の検査用） */
export function isMondayJst(day: string): boolean {
  const date = jstMidnight(day);
  if (!date) return false;
  // JST に 9 時間足した UTC の曜日が、JST の曜日になる
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCDay() === 1;
}

export interface CycleOfDate {
  cycleId: CycleId;
  /** 周の何日目か（0〜13） */
  day: number;
  /** 周の始まり（起点の 00:00 JST。ISO 8601） */
  startsAt: string;
  /** 周の終わり（14 日後の 00:00 JST。ISO 8601。この時刻の瞬間は次の周） */
  endsAt: string;
}

function toIsoJstMidnight(date: Date): string {
  return `${jstDate(date)}T00:00:00+09:00`;
}

/**
 * ある日時（JST の日付で見る）が、どの周の何日目か。
 * 起点より前の日付は、直前の周（起点から 14 日ずつ遡った周）として同じ式で求める。
 */
export function cycleOf(date: Date, anchor: string): CycleOfDate {
  const anchorStart = jstMidnight(anchor);
  if (!anchorStart) throw new Error("起点は実在する YYYY-MM-DD の日付にしてください");
  const dayStart = new Date(`${jstDate(date)}T00:00:00+09:00`);
  const daysSinceAnchor = Math.round((dayStart.getTime() - anchorStart.getTime()) / DAY_MS);
  const index = Math.floor(daysSinceAnchor / CYCLE_LENGTH_DAYS);
  const day = daysSinceAnchor - index * CYCLE_LENGTH_DAYS;
  const start = new Date(anchorStart.getTime() + index * CYCLE_LENGTH_DAYS * DAY_MS);
  const end = new Date(start.getTime() + CYCLE_LENGTH_DAYS * DAY_MS);
  return {
    cycleId: `C-${jstDate(start)}`,
    day,
    startsAt: toIsoJstMidnight(start),
    endsAt: toIsoJstMidnight(end),
  };
}
