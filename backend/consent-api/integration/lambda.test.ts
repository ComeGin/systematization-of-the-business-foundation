import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../src/constants.js";
import { type AlbEvent, type AlbResult, createLambdaHandler, initRuntime, type Runtime } from "../src/lambda.js";
import { devValkeyPassword, pauseValkey, unpauseValkey, VALKEY_URL } from "./helpers/valkey.js";

// ALB の形のイベントで lambda.ts の handler を呼び、開発の Valkey を本物として使う（仕様 7 節）。
// Secrets Manager の代わりに、開発の Valkey のパスワードを loadPassword で渡す。
// キーの接頭辞を it-consent: にして、開発のデータ（consent:）と分け、afterAll で消す
const SITE = "http://localhost:4321";
const PREFIX = "it-consent:";
const ENV = { VALKEY_URL, VALKEY_KEY_PREFIX: PREFIX, SITE_URL: SITE, COOKIE_DOMAIN: "", CONSENT_POLICY_VERSION: "2026-10-01" };

const password = devValkeyPassword();
const runtimes: Runtime[] = [];
let direct: Redis;

/** コールドスタートから始まる handler（呼ぶたびに新しい実行環境とみなす） */
function coldHandler(): (event: AlbEvent) => Promise<AlbResult> {
  return createLambdaHandler(async () => {
    const runtime = await initRuntime({ env: ENV, loadPassword: async () => password });
    runtimes.push(runtime);
    return runtime;
  });
}

const post = (state: string, extra: Record<string, string> = {}): AlbEvent => ({
  httpMethod: "POST",
  path: "/v1/consent",
  headers: { origin: SITE, "content-type": "application/json", ...extra },
  body: JSON.stringify({ state }),
  isBase64Encoded: false,
});

const get = (extra: Record<string, string> = {}): AlbEvent => ({
  httpMethod: "GET",
  path: "/v1/consent",
  headers: { origin: SITE, ...extra },
  body: "",
  isBase64Encoded: false,
});

/** Set-Cookie から、次の要求の Cookie ヘッダーの値（名前=値）を取り出す */
const cookieFrom = (res: AlbResult) => res.headers["Set-Cookie"]!.split("; ")[0]!;
const idFrom = (res: AlbResult) => new URLSearchParams(cookieFrom(res).slice(COOKIE_NAME.length + 1)).get("id")!;

async function testKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await direct.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

beforeAll(() => {
  direct = new Redis(VALKEY_URL, { password: password || undefined });
});

afterEach(() => {
  unpauseValkey();
});

afterAll(async () => {
  const keys = await testKeys();
  if (keys.length > 0) await direct.del(...keys);
  await Promise.all(runtimes.map((runtime) => runtime.valkey.quit().catch(() => runtime.valkey.disconnect())));
  await direct.quit();
});

describe("ALB → Lambda → Valkey", () => {
  describe("正常系", () => {
    it("同意を記録して Cookie を返し、その Cookie で状態を取り出せる", async () => {
      const handler = coldHandler();
      const created = await handler(post("granted"));
      expect(created.statusCode).toBe(201);
      expect(created.headers["Set-Cookie"]).toMatch(new RegExp(`^${COOKIE_NAME}=s=granted&v=2026-10-01&id=`));
      expect(await direct.xlen(`${PREFIX}c:${idFrom(created)}`)).toBe(1);

      const read = await handler(get({ cookie: cookieFrom(created) }));
      expect(read.statusCode).toBe(200);
      expect(JSON.parse(read.body)).toMatchObject({ state: "granted", policy_version: "2026-10-01" });
    });

    it("撤回は同じ識別子の Stream に積まれ、最新の状態が denied になる", async () => {
      const handler = coldHandler();
      const first = await handler(post("granted"));
      const second = await handler(post("denied", { cookie: cookieFrom(first) }));
      expect(second.statusCode).toBe(201);
      expect(idFrom(second)).toBe(idFrom(first));
      expect(await direct.xlen(`${PREFIX}c:${idFrom(first)}`)).toBe(2);
      const read = await handler(get({ cookie: cookieFrom(second) }));
      expect(JSON.parse(read.body)).toMatchObject({ state: "denied" });
    });

    it("空入力: Cookie の無い GET は unset で、Valkey に何も作らない", async () => {
      const before = (await testKeys()).length;
      const res = await coldHandler()(get());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ state: "unset" });
      expect((await testKeys()).length).toBe(before);
    });
  });

  describe("異常系", () => {
    it("入力: 別のオリジンからの POST は 403 で、Valkey に書かない", async () => {
      const before = (await testKeys()).length;
      const res = await coldHandler()(post("granted", { origin: "https://evil.example" }));
      expect(res.statusCode).toBe(403);
      expect(res.headers["Set-Cookie"]).toBeUndefined();
      expect((await testKeys()).length).toBe(before);
    });

    it("サーバ: ウォームの状態で Valkey が止まると 503 で Cookie を書かず、再開すると記録できる", async () => {
      const handler = coldHandler();
      expect((await handler(get())).statusCode).toBe(200); // 初期化を済ませる
      pauseValkey();
      const failed = await handler(post("granted"));
      expect(failed.statusCode).toBe(503);
      expect(JSON.parse(failed.body)).toEqual({ error: "unavailable" });
      expect(failed.headers["Set-Cookie"]).toBeUndefined();
      unpauseValkey();
      await vi.waitFor(async () => expect((await handler(post("granted"))).statusCode).toBe(201), { timeout: 20_000, interval: 500 });
    });

    it("サーバ: Valkey が止まった状態のコールドスタートは初期化の失敗になり、再開後の呼び出しで回復する", async () => {
      const handler = coldHandler();
      pauseValkey();
      await expect(handler(get())).rejects.toThrow("Valkey");
      unpauseValkey();
      await vi.waitFor(async () => expect((await handler(get())).statusCode).toBe(200), { timeout: 20_000, interval: 500 });
    });
  });
});
