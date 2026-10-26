import type { Redis } from "ioredis";

type Entry = [id: string, fields: string[]];
type Failable = "exec" | "exists" | "xlen" | "eval" | "xadd" | "xrevrange";

/**
 * ConsentStore が使うコマンド（pipeline の exists/xlen・eval・xadd・xrevrange）だけを持つ Valkey の偽物。
 * Stream は Map に持つ。fail に入れたコマンドはその Error で失敗する。
 * eval は append の書き込みのスクリプト（store.ts）だけを真似る。期限を Valkey の時計（serverTimeMs）で比べ、
 * 過ぎていなければ xadd に任せる（calls には中で実行した xadd が残り、eval の引数は evals に残る）。
 * 実装していないコマンド（expire・xtrim など）に触れると unexpected に名前を残し、呼べば例外にする。
 * 遅延や Error でない値での失敗を再現したいときは、テストの中で xadd・xrevrange をインスタンスごとに上書きする
 * （restoreMocks が true のため vi.fn の実装には頼らない）
 */
export class FakeRedis {
  readonly streams = new Map<string, Entry[]>();
  readonly calls: Array<{ command: string; args: unknown[] }> = [];
  readonly unexpected: string[] = [];
  /** eval に渡されたキーと引数（スクリプトの本文は持たない） */
  readonly evals: Array<{ keys: string[]; args: string[] }> = [];
  fail: Partial<Record<Failable, Error>> = {};
  /** スクリプトの TIME が返す Valkey の時計（ミリ秒）。未設定なら Date.now() */
  serverTimeMs: number | undefined = undefined;
  /** pipeline().exec() が null を返す状態（ioredis では接続が無いときなどに起こる） */
  execReturnsNull = false;
  /** pipeline().exec() が返す結果を差し替える（件数が足りない・形が違うなど、想定外の応答を再現する） */
  execResult: Array<[Error | null, unknown]> | undefined = undefined;
  private seq = 0;

  /** Redis 型として渡すための入口。未実装のコマンドへのアクセスを記録する */
  asRedis(): Redis {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === "string" && !(prop in target) && prop !== "then") {
          target.unexpected.push(prop);
          return () => {
            throw new Error(`FakeRedis: 未実装のコマンド ${prop}`);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Redis;
  }

  /** 既存の記録を直接積む（テストの前提づくり用。calls には残さない） */
  seed(key: string, ...records: Array<Record<string, string>>): void {
    const entries = this.streams.get(key) ?? [];
    for (const record of records) entries.push([this.nextId(), Object.entries(record).flat()]);
    this.streams.set(key, entries);
  }

  pipeline() {
    const ops: Array<{ name: Failable; run: () => unknown }> = [];
    const pipe = {
      exists: (key: string) => {
        this.calls.push({ command: "exists", args: [key] });
        ops.push({ name: "exists", run: () => (this.streams.has(key) ? 1 : 0) });
        return pipe;
      },
      xlen: (key: string) => {
        this.calls.push({ command: "xlen", args: [key] });
        ops.push({ name: "xlen", run: () => this.streams.get(key)?.length ?? 0 });
        return pipe;
      },
      exec: async (): Promise<Array<[Error | null, unknown]> | null> => {
        if (this.fail.exec) throw this.fail.exec;
        if (this.execReturnsNull) return null;
        if (this.execResult) return this.execResult;
        return ops.map(({ name, run }) => {
          const error = this.fail[name];
          return error ? [error, null] : [null, run()];
        });
      },
    };
    return pipe;
  }

  /** 引数は KEYS[1]（Stream）と ARGV（期限・state・at・policy）。期限を過ぎていれば書かずに 0、書けたら 1 */
  async eval(_script: string, numKeys: number, ...rest: string[]): Promise<number> {
    const keys = rest.slice(0, numKeys);
    const args = rest.slice(numKeys);
    this.evals.push({ keys, args });
    if (this.fail.eval) throw this.fail.eval;
    const [deadline, state, at, policy] = args;
    if ((this.serverTimeMs ?? Date.now()) > Number(deadline)) return 0;
    await this.xadd(keys[0]!, "*", "state", state!, "at", at!, "policy", policy!);
    return 1;
  }

  async xadd(key: string, id: string, ...fields: string[]): Promise<string> {
    this.calls.push({ command: "xadd", args: [key, id, ...fields] });
    if (this.fail.xadd) throw this.fail.xadd;
    const entryId = this.nextId();
    const entries = this.streams.get(key) ?? [];
    entries.push([entryId, fields]);
    this.streams.set(key, entries);
    return entryId;
  }

  async xrevrange(key: string, ...args: Array<string | number>): Promise<Entry[]> {
    this.calls.push({ command: "xrevrange", args: [key, ...args] });
    if (this.fail.xrevrange) throw this.fail.xrevrange;
    const entries = [...(this.streams.get(key) ?? [])].reverse();
    const countIndex = args.indexOf("COUNT");
    return countIndex === -1 ? entries : entries.slice(0, Number(args[countIndex + 1]));
  }

  /** Stream に積まれた記録を、フィールドのオブジェクトにして返す */
  records(key: string): Array<Record<string, string>> {
    return (this.streams.get(key) ?? []).map(([, fields]) => {
      const record: Record<string, string> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) record[fields[i]!] = fields[i + 1]!;
      return record;
    });
  }

  private nextId(): string {
    this.seq += 1;
    return `1700000000000-${this.seq}`;
  }
}
