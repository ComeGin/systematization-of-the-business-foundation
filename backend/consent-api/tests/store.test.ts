import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentStore, StoreUnavailableError } from "../src/store.js";
import { FakeRedis } from "./helpers/fake-redis.js";

const ID = "eAd5tbgdBQH8cAOA_oELjQ";
const KEY = `consent:c:${ID}`;
const RECORD = { state: "granted", at: "2026-10-05T00:00:00.000Z", policy: "2026-10-01" } as const;

let redis: FakeRedis;
let store: ConsentStore;

beforeEach(() => {
  redis = new FakeRedis();
  store = new ConsentStore(redis.asRedis(), "consent:");
});

/** StoreUnavailableError で、元のエラーを cause に持つことを確かめる */
async function expectUnavailable(promise: Promise<unknown>, cause?: Error): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(StoreUnavailableError);
  expect((error as Error).message).toBe("Valkey is unavailable");
  if (cause) expect((error as Error).cause).toBe(cause);
}

/** ioredis が接続断・タイムアウト・応答エラーで投げる代表的なメッセージ */
const VALKEY_FAILURES = [
  ["コマンドのタイムアウト", "Command timed out"],
  ["接続断", "Connection is closed."],
  ["オフラインキューなしで未接続", "Stream isn't writeable and enableOfflineQueue options is false"],
  ["再試行の上限", "Reached the max retries per request limit (which is 1). Refer to \"maxRetriesPerRequest\" option for details."],
  ["認証エラー", "NOAUTH Authentication required."],
  ["メモリ不足", "OOM command not allowed when used memory > 'maxmemory'."],
  ["フェイルオーバー中の読み取り専用", "READONLY You can't write against a read only replica."],
] as const;

describe("キーの形", () => {
  describe("正常系", () => {
    it("接頭辞のあとに c: と識別子を付けたキーに書く", async () => {
      await store.append(ID, RECORD);
      expect([...redis.streams.keys()]).toEqual([KEY]);
    });

    it("接頭辞を変えると別の名前空間になる", async () => {
      const other = new ConsentStore(redis.asRedis(), "stg-consent:");
      await other.append(ID, RECORD);
      expect([...redis.streams.keys()]).toEqual([`stg-consent:c:${ID}`]);
    });

    it("inspect・append・latest はすべて同じキーを使う", async () => {
      await store.inspect(ID);
      await store.append(ID, RECORD);
      await store.latest(ID);
      expect(new Set(redis.calls.map((call) => call.args[0]))).toEqual(new Set([KEY]));
    });
  });
});

describe("append", () => {
  describe("正常系", () => {
    it("XADD で ID を自動採番し、state・at・policy の 3 項目だけを積む", async () => {
      await store.append(ID, RECORD);
      expect(redis.calls).toEqual([
        { command: "xadd", args: [KEY, "*", "state", "granted", "at", RECORD.at, "policy", "2026-10-01"] },
      ]);
    });

    it("同じ識別子への 2 回目は上書きせずに積み増す（撤回の履歴も残す）", async () => {
      await store.append(ID, RECORD);
      await store.append(ID, { ...RECORD, state: "denied", at: "2026-10-06T00:00:00.000Z" });
      expect(redis.records(KEY)).toEqual([
        RECORD,
        { state: "denied", at: "2026-10-06T00:00:00.000Z", policy: "2026-10-01" },
      ]);
    });

    it("TTL も MAXLEN も付けない（EXPIRE・XTRIM などのコマンドを呼ばない）", async () => {
      await store.append(ID, RECORD);
      expect(redis.unexpected).toEqual([]);
      const xadd = redis.calls.find((call) => call.command === "xadd")!;
      expect(xadd.args).not.toContain("MAXLEN");
      expect(xadd.args).not.toContain("MINID");
    });

    it("書き込みは 1 本のスクリプト（EVAL）で送り、期限は受け付けからコマンドのタイムアウトの 0.5 秒手前", async () => {
      const before = Date.now();
      await store.append(ID, RECORD);
      const after = Date.now();
      expect(redis.evals).toHaveLength(1);
      const { keys, args } = redis.evals[0]!;
      expect(keys).toEqual([KEY]);
      expect(args.slice(1)).toEqual(["granted", RECORD.at, "2026-10-01"]);
      const deadline = Number(args[0]);
      expect(deadline).toBeGreaterThanOrEqual(before + 1_500);
      expect(deadline).toBeLessThanOrEqual(after + 1_500);
    });

    it("Valkey の時計が期限ちょうどなら書く（期限を過ぎたときだけ書かない）", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
        redis.serverTimeMs = Date.now() + 1_500;
        await store.append(ID, RECORD);
        expect(redis.records(KEY)).toEqual([RECORD]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("異常系", () => {
    it("サーバ: Valkey の失敗は StoreUnavailableError に包む", async () => {
      const cause = new Error("Command timed out");
      redis.fail.xadd = cause;
      await expectUnavailable(store.append(ID, RECORD), cause);
    });

    it.each(VALKEY_FAILURES)("サーバ: %s（%s）も StoreUnavailableError に包む", async (_label, message) => {
      const cause = new Error(message);
      redis.fail.xadd = cause;
      await expectUnavailable(store.append(ID, RECORD), cause);
    });

    it("サーバ: 遅れて返るタイムアウトも StoreUnavailableError に包み、記録は残らない", async () => {
      const cause = new Error("Command timed out");
      redis.xadd = (key: string, id: string, ...fields: string[]) => {
        redis.calls.push({ command: "xadd", args: [key, id, ...fields] });
        return new Promise((_resolve, reject) => setTimeout(() => reject(cause), 10));
      };
      await expectUnavailable(store.append(ID, RECORD), cause);
      expect(redis.streams.size).toBe(0);
    });

    it("サーバ: 止まっていた書き込みが期限の後に Valkey で実行されても、書かずに StoreUnavailableError にする", async () => {
      // Valkey の応答が止まり、クライアントが待つのをやめた後に、届いていたスクリプトが実行された状態
      redis.serverTimeMs = Date.now() + 60_000;
      const error = await store.append(ID, RECORD).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(StoreUnavailableError);
      expect(((error as Error).cause as Error).message).toBe("write deadline passed");
      expect(redis.streams.size).toBe(0);
      expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
    });

    it("サーバ: Valkey の時計が期限を 1 ミリ秒でも過ぎていれば書かない", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-10-26T00:00:00.000Z"));
        redis.serverTimeMs = Date.now() + 1_501;
        await expectUnavailable(store.append(ID, RECORD));
        expect(redis.streams.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("サーバ: スクリプトが 1 以外（null など想定外の値）を返したら、書けたとみなさず StoreUnavailableError", async () => {
      redis.eval = async () => null as unknown as number;
      await expectUnavailable(store.append(ID, RECORD));
    });

    it("サーバ: スクリプトの送信そのものの失敗（NOSCRIPT など）も StoreUnavailableError に包む", async () => {
      const cause = new Error("ERR Error running script");
      redis.fail.eval = cause;
      await expectUnavailable(store.append(ID, RECORD), cause);
    });

    it("サーバ: Error でない値で失敗しても StoreUnavailableError に包み、cause に元の値を持つ", async () => {
      redis.xadd = async () => {
        throw "ECONNRESET";
      };
      const error = await store.append(ID, RECORD).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(StoreUnavailableError);
      expect((error as Error).cause).toBe("ECONNRESET");
    });

    it("サーバ: 例外の文面に識別子も記録の値も含めない", async () => {
      redis.fail.xadd = new Error("Command timed out");
      const error = (await store.append(ID, RECORD).catch((reason: unknown) => reason)) as Error;
      expect(error.message).not.toContain(ID);
      expect(error.message).not.toContain(RECORD.at);
    });
  });
});

describe("inspect", () => {
  describe("正常系", () => {
    it("空入力: Stream が無ければ exists=false・count=0", async () => {
      await expect(store.inspect(ID)).resolves.toEqual({ exists: false, count: 0 });
    });

    it("Stream があれば exists=true と積まれた件数を返す", async () => {
      redis.seed(KEY, RECORD, RECORD, RECORD);
      await expect(store.inspect(ID)).resolves.toEqual({ exists: true, count: 3 });
    });

    it("EXISTS と XLEN を 1 回のパイプラインで同じキーに送る", async () => {
      await store.inspect(ID);
      expect(redis.calls).toEqual([
        { command: "exists", args: [KEY] },
        { command: "xlen", args: [KEY] },
      ]);
    });

    it("RESP の応答が文字列の数でも数値として読む", async () => {
      redis.execResult = [
        [null, "1"],
        [null, "42"],
      ];
      await expect(store.inspect(ID)).resolves.toEqual({ exists: true, count: 42 });
    });
  });

  describe("異常系", () => {
    it("サーバ: パイプライン全体の失敗は StoreUnavailableError に包む", async () => {
      const cause = new Error("Connection is closed.");
      redis.fail.exec = cause;
      await expectUnavailable(store.inspect(ID), cause);
    });

    it.each(VALKEY_FAILURES)("サーバ: パイプラインが %s（%s）で失敗しても StoreUnavailableError に包む", async (_label, message) => {
      const cause = new Error(message);
      redis.fail.exec = cause;
      await expectUnavailable(store.inspect(ID), cause);
    });

    it("サーバ: exec が null（結果なし）でも StoreUnavailableError にする", async () => {
      redis.execReturnsNull = true;
      await expectUnavailable(store.inspect(ID));
    });

    it("空入力: exec の結果が空の配列でも StoreUnavailableError にする（存在しないと見なして新しい識別子を発行しない）", async () => {
      redis.execResult = [];
      await expectUnavailable(store.inspect(ID));
    });

    it("サーバ: exec の結果が 1 件しか無い（XLEN の結果が欠ける）なら StoreUnavailableError にする", async () => {
      redis.execResult = [[null, 1]];
      await expectUnavailable(store.inspect(ID));
    });

    it("サーバ: EXISTS だけの失敗も StoreUnavailableError にする", async () => {
      const cause = new Error("LOADING");
      redis.fail.exists = cause;
      await expectUnavailable(store.inspect(ID), cause);
    });

    it("サーバ: XLEN だけの失敗（キーが Stream でない WRONGTYPE など）も StoreUnavailableError にする", async () => {
      const cause = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
      redis.fail.xlen = cause;
      await expectUnavailable(store.inspect(ID), cause);
    });
  });
});

describe("latest", () => {
  describe("正常系", () => {
    it("空入力: Stream が無ければ null", async () => {
      await expect(store.latest(ID)).resolves.toBeNull();
    });

    it("空入力: XREVRANGE が 0 件を返せば null", async () => {
      redis.streams.set(KEY, []);
      await expect(store.latest(ID)).resolves.toBeNull();
    });

    it("いちばん新しい 1 件だけを XREVRANGE で取り出す", async () => {
      redis.seed(KEY, RECORD, { ...RECORD, state: "denied", at: "2026-10-07T00:00:00.000Z" });
      await expect(store.latest(ID)).resolves.toEqual({
        state: "denied",
        at: "2026-10-07T00:00:00.000Z",
        policy: "2026-10-01",
      });
      expect(redis.calls).toEqual([{ command: "xrevrange", args: [KEY, "+", "-", "COUNT", 1] }]);
    });

    it("項目の並び順が違っても読める", async () => {
      redis.seed(KEY, { policy: "v9", at: RECORD.at, state: "granted" });
      await expect(store.latest(ID)).resolves.toEqual({ state: "granted", at: RECORD.at, policy: "v9" });
    });

    it("想定外の項目があっても 3 項目だけを返す", async () => {
      redis.seed(KEY, { ...RECORD, extra: "x" });
      await expect(store.latest(ID)).resolves.toEqual(RECORD);
    });
  });

  describe("異常系", () => {
    it.each([
      ["state が想定外", { ...RECORD, state: "unset" }],
      ["state が無い", { at: RECORD.at, policy: RECORD.policy }],
      ["at が無い", { state: "granted", policy: RECORD.policy }],
      ["policy が空", { ...RECORD, policy: "" }],
    ])("サーバ: 最新の記録が壊れていれば（%s）null", async (_label, record) => {
      redis.seed(KEY, record);
      await expect(store.latest(ID)).resolves.toBeNull();
    });

    it("空入力: 最新の記録の項目が空なら null", async () => {
      redis.streams.set(KEY, [["1-1", []]]);
      await expect(store.latest(ID)).resolves.toBeNull();
    });

    it("サーバ: 項目の数が奇数（値が欠けた）記録は、欠けた項目を読まずに null", async () => {
      redis.streams.set(KEY, [["1-1", ["state", "granted", "at", RECORD.at, "policy"]]]);
      await expect(store.latest(ID)).resolves.toBeNull();
    });

    it("サーバ: Valkey の失敗は StoreUnavailableError に包む", async () => {
      const cause = new Error("Command timed out");
      redis.fail.xrevrange = cause;
      await expectUnavailable(store.latest(ID), cause);
    });

    it.each(VALKEY_FAILURES)("サーバ: %s（%s）も StoreUnavailableError に包む", async (_label, message) => {
      const cause = new Error(message);
      redis.fail.xrevrange = cause;
      await expectUnavailable(store.latest(ID), cause);
    });

    it("サーバ: XREVRANGE が配列でない応答（null）を返したら、未記録と見なさず StoreUnavailableError にする", async () => {
      redis.xrevrange = async () => null as never;
      await expectUnavailable(store.latest(ID));
    });
  });
});
