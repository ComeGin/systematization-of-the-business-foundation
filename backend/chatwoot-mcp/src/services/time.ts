/**
 * Chatwoot は日時を Unix 秒で扱う（レスポンスの created_at、レポートの since / until など）。
 * モデルとのやり取りは ISO 8601 で行い、ここで相互に変換する。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** 時差（Z・+09:00 など）の付いていない日時 */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

export class TimeZone {
  readonly #offsetHours: number;

  constructor(offsetHours: number) {
    this.#offsetHours = offsetHours;
  }

  get offsetHours(): number {
    return this.#offsetHours;
  }

  /** Unix 秒（または ISO 文字列）を、設定した時差の ISO 8601（例: 2026-09-16T07:00:00+09:00）にする。0 や空は null */
  format(value: unknown): string | null {
    let ms: number;
    if (typeof value === "number") {
      if (value <= 0) return null;
      ms = value * 1000;
    } else if (typeof value === "string" && value !== "") {
      ms = Date.parse(value);
      if (Number.isNaN(ms)) return value;
    } else {
      return null;
    }
    const local = new Date(ms + this.#offsetHours * 3_600_000).toISOString().slice(0, 19);
    return `${local}${this.#suffix()}`;
  }

  /**
   * ISO 8601 の日時、または日付（YYYY-MM-DD。設定した時差で解釈）を Unix 秒にする。
   * @param endOfDay 日付だけが指定された場合に、その日の終わり（23:59:59）にする
   */
  toUnix(value: string, endOfDay = false): number {
    if (DATE_ONLY.test(value)) {
      // 形は合っていても 2026-13-45 のような存在しない日付は Date.parse が NaN を返す
      const startMs = Date.parse(`${value}T00:00:00${this.#suffix()}`);
      if (Number.isNaN(startMs) || !hasRealDate(value)) {
        throw new RangeError(`Invalid date '${value}'. Use a real calendar date in YYYY-MM-DD.`);
      }
      return Math.floor(startMs / 1000) + (endOfDay ? 86_399 : 0);
    }
    // 時差の無い日時（2026-09-17T09:00 など）は、Date.parse だとプロセスのローカル時刻になるため、設定した時差を付けて解釈する
    const ms = Date.parse(LOCAL_DATE_TIME.test(value) ? `${value.replace(" ", "T")}${this.#suffix()}` : value);
    if (Number.isNaN(ms)) throw new RangeError(`Invalid date '${value}'. Use YYYY-MM-DD or an ISO 8601 date-time.`);
    if (!hasRealDate(value)) throw new RangeError(`Invalid date '${value}'. Use a real calendar date in the YYYY-MM-DD part.`);
    return Math.floor(ms / 1000);
  }

  #suffix(): string {
    const sign = this.#offsetHours < 0 ? "-" : "+";
    const abs = Math.abs(this.#offsetHours);
    const hours = String(Math.floor(abs)).padStart(2, "0");
    const minutes = String(Math.round((abs % 1) * 60)).padStart(2, "0");
    return `${sign}${hours}:${minutes}`;
  }
}

/**
 * 先頭の YYYY-MM-DD の日が、その月に実在するか（閏年を含む）。
 * Date.parse は日を 31 まで受け付けて翌月に繰り越す（2026-02-30 → 03-02）ため、Date.parse が NaN でなくても確かめる
 */
function hasRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return true;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(0);
  // Date.UTC は 0〜99 年を 1900 年代とみなすため、setUTCFullYear で組み立てる
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export interface UnixRange {
  since: number;
  until: number;
}

/** レポート用の期間。省略時は「直近 30 日」 */
export function resolveRange(tz: TimeZone, since: string | undefined, until: string | undefined): UnixRange {
  const untilUnix = until ? tz.toUnix(until, true) : Math.floor(Date.now() / 1000);
  const sinceUnix = since ? tz.toUnix(since) : untilUnix - 30 * 86_400;
  if (sinceUnix >= untilUnix) throw new RangeError("since must be earlier than until.");
  return { since: sinceUnix, until: untilUnix };
}
