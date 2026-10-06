import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Config } from "../src/config.js";
import { COOKIE_NAME, ID_PATTERN } from "../src/constants.js";
import { createServer } from "../src/server.js";
import { ConsentStore } from "../src/store.js";
import { makeConfig } from "./helpers/config.js";
import { FakeRedis } from "./helpers/fake-redis.js";
import { close, listen, type RequestOptions, request, type TestResponse } from "./helpers/http.js";

const SITE = "https://comegin.com";
const OTHER_SITE = "https://evil.example";
const EXISTING_ID = "eAd5tbgdBQH8cAOA_oELjQ";
const UNKNOWN_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const keyOf = (id: string) => `test:c:${id}`;
const STORED = { state: "granted", at: "2026-10-01T09:00:00.000Z", policy: "2026-09-01" };

let redis: FakeRedis;
let server: http.Server;
let baseUrl: string;
let stderr: MockInstance<typeof console.error>;

async function start(config: Config = makeConfig(), store?: ConsentStore): Promise<void> {
  server = createServer(config, store ?? new ConsentStore(redis.asRedis(), config.VALKEY_KEY_PREFIX));
  baseUrl = await listen(server);
}

beforeEach(async () => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  redis = new FakeRedis();
  await start();
});

afterEach(async () => {
  await close(server);
});

const send = (options: RequestOptions) => request(baseUrl, options);

const post = (body: string, headers: http.OutgoingHttpHeaders = {}) =>
  send({
    method: "POST",
    body,
    headers: { Origin: SITE, "Content-Type": "application/json", ...headers },
  });

const cookieOf = (id: string, state = "granted") => `${COOKIE_NAME}=s=${state}&v=2026-10-01&id=${id}`;

function setCookie(res: TestResponse): string | undefined {
  return res.headers["set-cookie"]?.[0];
}

/** Set-Cookie から識別子を取り出す */
function issuedId(res: TestResponse): string {
  const value = setCookie(res)!.split("; ")[0]!.slice(COOKIE_NAME.length + 1);
  return new URLSearchParams(value).get("id")!;
}

describe("共通の応答ヘッダー", () => {
  it.each<[string, RequestOptions]>([
    ["成功", { headers: { Origin: SITE } }],
    ["404", { path: "/nope" }],
    ["403", { headers: { Origin: OTHER_SITE } }],
    ["ヘルスチェック", { path: "/healthz" }],
  ])("どの応答（%s）にも Cache-Control: no-store と nosniff を付け、JSON で返す", async (_label, options) => {
    const res = await send(options);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("知らないパスは 404 not_found", async () => {
    const res = await send({ path: "/v1/consent/extra" });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "not_found" });
  });

  it("クエリ文字列が付いていても同じパスとして扱う", async () => {
    const res = await send({ path: "/v1/consent?x=1", headers: { Origin: SITE } });
    expect(res.status).toBe(200);
  });

  it("keep-alive を ALB のアイドルタイムアウト（60 秒）より長くし、headersTimeout はさらに長くする", () => {
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBeGreaterThan(0);
  });
});

describe("GET /healthz", () => {
  it("GET と HEAD に 200 を返す", async () => {
    const get = await send({ path: "/healthz" });
    expect(get.status).toBe(200);
    expect(get.json).toEqual({ ok: true });
    const head = await send({ path: "/healthz", method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("Valkey を見ない（落ちていても 200。瞬断でタスクが ALB から外れないように）", async () => {
    redis.fail = { exec: new Error("down"), xadd: new Error("down"), xrevrange: new Error("down") };
    const res = await send({ path: "/healthz" });
    expect(res.status).toBe(200);
    expect(redis.calls).toEqual([]);
  });

  it("GET・HEAD 以外は 405 で、Allow を返す", async () => {
    const res = await send({ path: "/healthz", method: "POST" });
    expect(res.status).toBe(405);
    expect(res.json).toEqual({ error: "method_not_allowed" });
    expect(res.headers.allow).toBe("GET, HEAD");
  });
});

describe("CORS", () => {
  it("SITE_URL と一致するオリジンにだけ、資格情報つきで許可を返す（* は使わない）", async () => {
    const res = await send({ headers: { Origin: SITE } });
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers.vary).toBe("Origin");
  });

  it("Origin が無い GET には許可のヘッダーを付けないが、Vary: Origin は付ける", async () => {
    const res = await send({});
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toBe("Origin");
  });

  it("SITE_URL にパスが付いた設定でも、オリジンで照合する（設定側で正規化済みの値を使う）", async () => {
    await close(server);
    await start(makeConfig({ SITE_URL: "http://localhost:4321" }));
    const res = await send({ headers: { Origin: "http://localhost:4321" } });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4321");
  });

  it.each([
    ["別サイト", OTHER_SITE],
    ["http と https の違い", "http://comegin.com"],
    ["サブドメイン", "https://consent.comegin.com"],
    ["末尾のスラッシュ", `${SITE}/`],
    ["null オリジン", "null"],
  ])("%s のオリジンには許可を返さない", async (_label, origin) => {
    const res = await send({ headers: { Origin: origin } });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  describe("プリフライト（OPTIONS）", () => {
    it("許したオリジンには 204 と、メソッド・ヘッダー・Max-Age を返す", async () => {
      const res = await send({
        method: "OPTIONS",
        headers: { Origin: SITE, "Access-Control-Request-Method": "POST" },
      });
      expect(res.status).toBe(204);
      expect(res.text).toBe("");
      expect(res.headers).toMatchObject({
        "access-control-allow-origin": SITE,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
        "access-control-max-age": "600",
        vary: "Origin",
      });
    });

    it("ほかのオリジンには 403 origin_not_allowed", async () => {
      const res = await send({ method: "OPTIONS", headers: { Origin: OTHER_SITE } });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    });

    it("Origin が無ければ 403", async () => {
      const res = await send({ method: "OPTIONS" });
      expect(res.status).toBe(403);
    });
  });

  it.each(["PUT", "DELETE", "PATCH", "HEAD"])("%s は 405 で、Allow: GET, POST, OPTIONS を返す", async (method) => {
    const res = await send({ method, headers: { Origin: SITE } });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, POST, OPTIONS");
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
  });
});

describe("POST /v1/consent: 拒否する入力", () => {
  it("Origin が無ければ 403（書き込みは必ず公開サイトから）", async () => {
    const res = await send({
      method: "POST",
      body: '{"state":"granted"}',
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "origin_not_allowed" });
    expect(redis.calls).toEqual([]);
  });

  it("別のオリジンからは 403 で、記録も Cookie も作らない", async () => {
    const res = await post('{"state":"granted"}', { Origin: OTHER_SITE });
    expect(res.status).toBe(403);
    expect(setCookie(res)).toBeUndefined();
    expect(redis.streams.size).toBe(0);
  });

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
    "Content-Type が %s なら 415 unsupported_media_type",
    async (contentType) => {
      const headers: http.OutgoingHttpHeaders = { Origin: SITE };
      if (contentType) headers["Content-Type"] = contentType;
      const res = await send({ method: "POST", body: '{"state":"granted"}', headers });
      expect(res.status).toBe(415);
      expect(res.json).toEqual({ error: "unsupported_media_type" });
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    },
  );

  it.each(["", "{", "state=granted", '{"state":"granted"}x'])("JSON として読めない本文（%j）は 400 invalid_json", async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_json" });
  });

  it.each([
    ["state が想定外", { state: "unset" }],
    ["state が大文字", { state: "GRANTED" }],
    ["state が無い", {}],
    ["識別子を送ってくる", { state: "granted", id: EXISTING_ID }],
    ["ポリシーの版を送ってくる", { state: "granted", policy_version: "2099-01-01" }],
    ["時刻を送ってくる", { state: "granted", recorded_at: "2000-01-01T00:00:00Z" }],
    ["配列", ["granted"]],
    ["null", null],
    ["文字列", "granted"],
  ])("本文が不正（%s）なら 400 invalid_body で、記録しない", async (_label, body) => {
    const res = await post(JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_body" });
    expect(setCookie(res)).toBeUndefined();
    expect(redis.streams.size).toBe(0);
  });

  it("宣言された Content-Length が 1 KiB を超えれば、本文を読まずに 413 で接続を閉じる", async () => {
    const res = await send({
      method: "POST",
      headersOnly: true,
      headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": "4096" },
    });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: "payload_too_large" });
    expect(res.headers.connection).toBe("close");
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
  });

  it("Content-Length なし（チャンク）でも 1 KiB を超えた時点で 413", async () => {
    const res = await send({
      method: "POST",
      chunked: true,
      body: `{"state":"granted","pad":"${"x".repeat(1100)}"}`,
      headers: { Origin: SITE, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: "payload_too_large" });
    expect(redis.streams.size).toBe(0);
  });

  it("本文はちょうど 1024 バイトまで受け付け、1025 バイトは 413", async () => {
    const base = '{"state":"granted"}';
    const exact = base + " ".repeat(1024 - base.length);
    expect((await post(exact)).status).toBe(201);
    expect((await post(`${exact} `)).status).toBe(413);
  });
});

describe("POST /v1/consent: 記録と Cookie", () => {
  it("201 と、状態・サーバーの版・記録の時刻を返す。識別子は本文に返さない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:34:56.789Z"));
    try {
      const res = await post('{"state":"granted"}');
      expect(res.status).toBe(201);
      expect(res.json).toEqual({
        state: "granted",
        policy_version: "2026-10-01",
        recorded_at: "2026-10-05T12:34:56.789Z",
      });
      expect(res.text).not.toContain(issuedId(res));
    } finally {
      vi.useRealTimers();
    }
  });

  it("サーバーが発行した識別子の Stream に、state・時刻・サーバーの版を積む", async () => {
    const res = await post('{"state":"denied"}');
    const id = issuedId(res);
    expect(id).toMatch(ID_PATTERN);
    expect(redis.records(keyOf(id))).toEqual([
      { state: "denied", at: (res.json as { recorded_at: string }).recorded_at, policy: "2026-10-01" },
    ]);
  });

  it("Set-Cookie は状態・版・識別子を持ち、HttpOnly なしで Secure・SameSite=Lax・Domain を付ける", async () => {
    const res = await post('{"state":"granted"}');
    const cookie = setCookie(res)!;
    expect(cookie).toBe(
      `${COOKIE_NAME}=s=granted&v=2026-10-01&id=${issuedId(res)}; Max-Age=31536000; Path=/; Secure; SameSite=Lax; Domain=.comegin.com`,
    );
    expect(cookie.toLowerCase()).not.toContain("httponly");
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("Content-Type のパラメーターと大文字小文字は問わない", async () => {
    const res = await post('{"state":"granted"}', { "Content-Type": "Application/JSON; charset=UTF-8" });
    expect(res.status).toBe(201);
  });

  it("Cookie が無ければ、毎回新しい識別子を発行する", async () => {
    const first = issuedId(await post('{"state":"granted"}'));
    const second = issuedId(await post('{"state":"granted"}'));
    expect(first).not.toBe(second);
    expect(redis.streams.size).toBe(2);
  });

  it("Cookie の識別子が発行済み（Stream がある）なら引き継ぎ、同じ Stream に積み増す", async () => {
    redis.seed(keyOf(EXISTING_ID), STORED);
    const res = await post('{"state":"denied"}', { Cookie: cookieOf(EXISTING_ID) });
    expect(res.status).toBe(201);
    expect(issuedId(res)).toBe(EXISTING_ID);
    const records = redis.records(keyOf(EXISTING_ID));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(STORED);
    expect(records[1]).toMatchObject({ state: "denied", policy: "2026-10-01" });
    expect(redis.streams.size).toBe(1);
  });

  it("Cookie の識別子が形式に合っていても未発行なら引き継がず、新しく発行する", async () => {
    const res = await post('{"state":"granted"}', { Cookie: cookieOf(UNKNOWN_ID) });
    expect(res.status).toBe(201);
    const id = issuedId(res);
    expect(id).not.toBe(UNKNOWN_ID);
    expect(redis.streams.has(keyOf(UNKNOWN_ID))).toBe(false);
    expect(redis.streams.has(keyOf(id))).toBe(true);
  });

  it("Cookie の識別子の形式が不正なら Valkey に問い合わせず、新しく発行する", async () => {
    const res = await post('{"state":"granted"}', { Cookie: `${COOKIE_NAME}=s=granted&id=../../etc` });
    expect(res.status).toBe(201);
    expect(issuedId(res)).toMatch(ID_PATTERN);
    expect(redis.calls.map((call) => call.command)).toEqual(["xadd"]);
  });

  it("1 つの識別子の記録が 199 件なら、まだ積める", async () => {
    redis.seed(keyOf(EXISTING_ID), ...Array.from({ length: 199 }, () => STORED));
    const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
    expect(res.status).toBe(201);
    expect(redis.records(keyOf(EXISTING_ID))).toHaveLength(200);
  });

  it("200 件に達していれば 429 too_many_records で、記録も Cookie も書かず、既存の記録を消さない", async () => {
    redis.seed(keyOf(EXISTING_ID), ...Array.from({ length: 200 }, () => STORED));
    const res = await post('{"state":"denied"}', { Cookie: cookieOf(EXISTING_ID) });
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: "too_many_records" });
    expect(setCookie(res)).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    expect(redis.records(keyOf(EXISTING_ID))).toHaveLength(200);
    expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
  });

  it("Valkey に書けなければ 503 unavailable で、Cookie を書かない", async () => {
    redis.fail.xadd = new Error("Command timed out");
    const res = await post('{"state":"granted"}');
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "unavailable" });
    expect(setCookie(res)).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
  });

  it("識別子の確認（inspect）で Valkey に届かなくても 503 で、Cookie を書かない", async () => {
    redis.fail.exec = new Error("Connection is closed.");
    const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
    expect(res.status).toBe(503);
    expect(setCookie(res)).toBeUndefined();
    expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
  });

  it("503 のログに Valkey の失敗理由を出す", async () => {
    redis.fail.xadd = new Error("Command timed out");
    await post('{"state":"granted"}');
    expect(stderr).toHaveBeenCalledWith("[store] Valkey is unavailable: Command timed out");
  });

  it("ストアの想定外の例外は 500 internal（詳細を返さない）", async () => {
    await close(server);
    const broken = {
      inspect: vi.fn(),
      latest: vi.fn(),
      append: vi.fn().mockRejectedValue(new TypeError("boom: internal detail")),
    } as unknown as ConsentStore;
    await start(makeConfig(), broken);
    const res = await post('{"state":"granted"}');
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "internal" });
    expect(res.text).not.toContain("boom");
    expect(setCookie(res)).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
  });

  it("COOKIE_DOMAIN が空の設定（開発）では Domain を付けない", async () => {
    await close(server);
    await start(makeConfig({ SITE_URL: "http://localhost:4321", COOKIE_DOMAIN: "" }));
    const res = await post('{"state":"granted"}', { Origin: "http://localhost:4321" });
    expect(res.status).toBe(201);
    expect(setCookie(res)!.toLowerCase()).not.toContain("domain=");
  });
});

describe("GET /v1/consent", () => {
  it("Cookie が無ければ unset（Valkey に問い合わせない）", async () => {
    const res = await send({ headers: { Origin: SITE } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ state: "unset" });
    expect(redis.calls).toEqual([]);
  });

  it("Cookie の識別子の最新の記録を返す（版はその記録のもの）", async () => {
    redis.seed(keyOf(EXISTING_ID), STORED, { ...STORED, state: "denied", at: "2026-10-02T09:00:00.000Z" });
    const res = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      state: "denied",
      policy_version: "2026-09-01",
      recorded_at: "2026-10-02T09:00:00.000Z",
    });
  });

  it("Cookie の状態ではなくサーバーの記録を返す", async () => {
    redis.seed(keyOf(EXISTING_ID), { ...STORED, state: "denied" });
    const res = await send({ headers: { Cookie: cookieOf(EXISTING_ID, "granted") } });
    expect((res.json as { state: string }).state).toBe("denied");
  });

  it("Stream の無い識別子は unset", async () => {
    const res = await send({ headers: { Cookie: cookieOf(UNKNOWN_ID) } });
    expect(res.json).toEqual({ state: "unset" });
  });

  it("形式が不正な識別子は unset（Valkey に問い合わせない）", async () => {
    const res = await send({ headers: { Cookie: `${COOKIE_NAME}=s=granted&id=*` } });
    expect(res.json).toEqual({ state: "unset" });
    expect(redis.calls).toEqual([]);
  });

  it("Origin が無い GET も受け付ける", async () => {
    redis.seed(keyOf(EXISTING_ID), STORED);
    const res = await send({ headers: { Cookie: cookieOf(EXISTING_ID) } });
    expect(res.status).toBe(200);
    expect((res.json as { state: string }).state).toBe("granted");
  });

  it("Origin が SITE_URL と違えば 403 で、記録を読まない", async () => {
    redis.seed(keyOf(EXISTING_ID), STORED);
    const res = await send({ headers: { Origin: OTHER_SITE, Cookie: cookieOf(EXISTING_ID) } });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: "origin_not_allowed" });
    expect(redis.calls).toEqual([]);
  });

  it("GET では Cookie を書かない", async () => {
    redis.seed(keyOf(EXISTING_ID), STORED);
    const withRecord = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
    const withoutRecord = await send({ headers: { Origin: SITE } });
    expect(setCookie(withRecord)).toBeUndefined();
    expect(setCookie(withoutRecord)).toBeUndefined();
  });

  it("GET は記録を作らない", async () => {
    await send({ headers: { Origin: SITE, Cookie: cookieOf(UNKNOWN_ID) } });
    expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
    expect(redis.streams.size).toBe(0);
  });

  it("Valkey が読めなければ 503 unavailable", async () => {
    redis.fail.xrevrange = new Error("Command timed out");
    const res = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: "unavailable" });
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
  });
});

describe("アクセスログ", () => {
  /** finish イベントのあとに出るアクセスログの 1 行を待って取り出す */
  async function accessLog(): Promise<Record<string, unknown>> {
    let line: string | undefined;
    await vi.waitFor(() => {
      line = stderr.mock.calls
        .map((args) => args[0])
        .find((arg): arg is string => typeof arg === "string" && arg.startsWith('{"t":'));
      expect(line).toBeDefined();
    });
    return JSON.parse(line!) as Record<string, unknown>;
  }

  it("stderr に JSON の 1 行（時刻・メソッド・パス・ステータス・所要時間）だけを出す", async () => {
    await send({ path: "/v1/consent?utm=1", headers: { Origin: SITE } });
    const log = await accessLog();
    expect(Object.keys(log).sort()).toEqual(["method", "ms", "path", "status", "t"]);
    expect(log).toMatchObject({ method: "GET", path: "/v1/consent", status: 200 });
    expect(typeof log.ms).toBe("number");
  });

  it("識別子と IP はログに出さない", async () => {
    redis.seed(keyOf(EXISTING_ID), STORED);
    const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
    expect(res.status).toBe(201);
    await accessLog();
    const output = stderr.mock.calls.flat().map(String).join("\n");
    expect(output).not.toContain(EXISTING_ID);
    expect(output).not.toContain("127.0.0.1");
  });
});
