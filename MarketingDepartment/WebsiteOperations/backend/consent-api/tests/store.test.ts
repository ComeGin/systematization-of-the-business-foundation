import { beforeEach, describe, expect, it } from "vitest";
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

describe("キーの形", () => {
  it("接頭辞のあとに c: と識別子を付けたキーに書く", async () => {
    await store.append(ID, RECORD);
    expect([...redis.streams.keys()]).toEqual([KEY]);
  });

  it("接頭辞を変えると別の名前空間になる", async () => {
    const other = new ConsentStore(redis.asRedis(), "stg-consent:");
    await other.append(ID, RECORD);
    expect([...redis.streams.keys()]).toEqual([`stg-consent:c:${ID}`]);
  });
});

describe("append", () => {
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

  it("Valkey の失敗は StoreUnavailableError に包む", async () => {
    const cause = new Error("Command timed out");
    redis.fail.xadd = cause;
    await expectUnavailable(store.append(ID, RECORD), cause);
  });
});

describe("inspect", () => {
  it("Stream が無ければ exists=false・count=0", async () => {
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

  it("パイプライン全体の失敗は StoreUnavailableError に包む", async () => {
    const cause = new Error("Connection is closed.");
    redis.fail.exec = cause;
    await expectUnavailable(store.inspect(ID), cause);
  });

  it("exec が null（結果なし）でも StoreUnavailableError にする", async () => {
    redis.execReturnsNull = true;
    await expectUnavailable(store.inspect(ID));
  });

  it("EXISTS だけの失敗も StoreUnavailableError にする", async () => {
    const cause = new Error("LOADING");
    redis.fail.exists = cause;
    await expectUnavailable(store.inspect(ID), cause);
  });

  it("XLEN だけの失敗（キーが Stream でない WRONGTYPE など）も StoreUnavailableError にする", async () => {
    const cause = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    redis.fail.xlen = cause;
    await expectUnavailable(store.inspect(ID), cause);
  });
});

describe("latest", () => {
  it("Stream が無ければ null", async () => {
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

  it.each([
    ["state が想定外", { ...RECORD, state: "unset" }],
    ["state が無い", { at: RECORD.at, policy: RECORD.policy }],
    ["at が無い", { state: "granted", policy: RECORD.policy }],
    ["policy が空", { ...RECORD, policy: "" }],
  ])("最新の記録が壊れていれば（%s）null", async (_label, record) => {
    redis.seed(KEY, record);
    await expect(store.latest(ID)).resolves.toBeNull();
  });

  it("Valkey の失敗は StoreUnavailableError に包む", async () => {
    const cause = new Error("Command timed out");
    redis.fail.xrevrange = cause;
    await expectUnavailable(store.latest(ID), cause);
  });
});
