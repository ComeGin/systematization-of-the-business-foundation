import type { Redis } from "ioredis";
import { VALKEY_COMMAND_TIMEOUT_MS, VALKEY_WRITE_DEADLINE_MARGIN_MS } from "./constants.js";

// 期限（Valkey の時計のミリ秒）を過ぎていれば書かずに 0、書けたら 1 を返す。
// コマンドのタイムアウトはクライアントが待つのをやめるだけで、送った XADD は取り消せない
// （接続が切れずに応答だけが止まると、Valkey は戻ったときに届いていたコマンドを実行する）。
// 期限があれば、503 を返して Cookie を書かなかった記録が、どの Cookie からも指されずに残ることがない。
// スクリプトは固定で、値はすべて KEYS・ARGV で渡す（スクリプトの文字列に埋め込まない）
const APPEND_BEFORE_DEADLINE = `
local now = redis.call('TIME')
if tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) > tonumber(ARGV[1]) then return 0 end
redis.call('XADD', KEYS[1], '*', 'state', ARGV[2], 'at', ARGV[3], 'policy', ARGV[4])
return 1
`;

export type ConsentState = "granted" | "denied";

export interface ConsentRecord {
  state: ConsentState;
  at: string;
  policy: string;
}

// Valkey に届かない・タイムアウトした。API は 503 を返す
export class StoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Valkey is unavailable", { cause });
  }
}

/**
 * 同意の記録。訪問者の識別子ごとに 1 本の Stream を持ち、追記だけを行う。
 * 値は state・時刻・ポリシーの版だけ（氏名・メール・IP は入れない）。TTL と MAXLEN は付けない。
 */
export class ConsentStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  private key(id: string): string {
    return `${this.prefix}c:${id}`;
  }

  /** その識別子の Stream があるか（サーバーが発行した識別子か）と、積まれた件数 */
  async inspect(id: string): Promise<{ exists: boolean; count: number }> {
    try {
      const results = await this.redis.pipeline().exists(this.key(id)).xlen(this.key(id)).exec();
      const [existsResult, countResult] = results ?? [];
      if (!existsResult || !countResult) throw new Error("empty pipeline result");
      const [existsError, exists] = existsResult;
      const [countError, count] = countResult;
      if (existsError) throw existsError;
      if (countError) throw countError;
      return { exists: Number(exists) === 1, count: Number(count) };
    } catch (error) {
      throw new StoreUnavailableError(error);
    }
  }

  /** 期限までに Valkey が実行できたときだけ積む。期限切れ（書いていない）も StoreUnavailableError */
  async append(id: string, record: ConsentRecord): Promise<void> {
    const deadline = Date.now() + VALKEY_COMMAND_TIMEOUT_MS - VALKEY_WRITE_DEADLINE_MARGIN_MS;
    let written: unknown;
    try {
      written = await this.redis.eval(
        APPEND_BEFORE_DEADLINE,
        1,
        this.key(id),
        String(deadline),
        record.state,
        record.at,
        record.policy,
      );
    } catch (error) {
      throw new StoreUnavailableError(error);
    }
    if (Number(written) !== 1) throw new StoreUnavailableError(new Error("write deadline passed"));
  }

  /** 最新の 1 件。Stream が無ければ null */
  async latest(id: string): Promise<ConsentRecord | null> {
    try {
      const entries = await this.redis.xrevrange(this.key(id), "+", "-", "COUNT", 1);
      const fields = entries[0]?.[1];
      if (!fields) return null;
      const map = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i]!, fields[i + 1]!);
      const state = map.get("state");
      const at = map.get("at");
      const policy = map.get("policy");
      if ((state !== "granted" && state !== "denied") || !at || !policy) return null;
      return { state, at, policy };
    } catch (error) {
      throw new StoreUnavailableError(error);
    }
  }
}
