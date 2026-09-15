/**
 * Chatwoot は日時を Unix 秒で扱う（レスポンスの created_at、レポートの since / until など）。
 * モデルとのやり取りは ISO 8601 で行い、ここで相互に変換する。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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
      if (Number.isNaN(startMs)) throw new RangeError(`Invalid date '${value}'. Use a real calendar date in YYYY-MM-DD.`);
      return Math.floor(startMs / 1000) + (endOfDay ? 86_399 : 0);
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new RangeError(`Invalid date '${value}'. Use YYYY-MM-DD or an ISO 8601 date-time.`);
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
