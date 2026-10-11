import type { Redis } from "ioredis";

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

  async append(id: string, record: ConsentRecord): Promise<void> {
    try {
      await this.redis.xadd(this.key(id), "*", "state", record.state, "at", record.at, "policy", record.policy);
    } catch (error) {
      throw new StoreUnavailableError(error);
    }
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
