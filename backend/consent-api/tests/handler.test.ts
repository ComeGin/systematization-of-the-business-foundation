import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Config } from "../src/config.js";
import { COOKIE_NAME, ID_PATTERN } from "../src/constants.js";
import { createHandler, type Handle } from "../src/handler.js";
import { ConsentStore } from "../src/store.js";
import { makeConfig } from "./helpers/config.js";
import { FakeRedis } from "./helpers/fake-redis.js";
import { type InvokeOptions, type InvokeResult, invoke } from "./helpers/handle.js";

// handler.ts（入口に依存しない本体）の検査。開発の入口（Node の http）に固有のこと
// （本文を途中で打ち切る 413・接続断・ヘッダーの大きさの上限・keep-alive）は server.test.ts で見る
const SITE = "https://comegin.com";
const OTHER_SITE = "https://evil.example";
const EXISTING_ID = "eAd5tbgdBQH8cAOA_oELjQ";
const UNKNOWN_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const keyOf = (id: string) => `test:c:${id}`;
const STORED = { state: "granted", at: "2026-10-01T09:00:00.000Z", policy: "2026-09-01" };

let redis: FakeRedis;
let handle: Handle;
let stderr: MockInstance<typeof console.error>;

function start(config: Config = makeConfig(), store?: ConsentStore): void {
  handle = createHandler({ config, store: store ?? new ConsentStore(redis.asRedis(), config.VALKEY_KEY_PREFIX) });
}

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  redis = new FakeRedis();
  start();
});

type RequestOptions = InvokeOptions;
type TestResponse = InvokeResult;

const send = (options: RequestOptions) => invoke(handle, options);

const post = (body: string, headers: Record<string, string> = {}) =>
  send({
    method: "POST",
    body,
    headers: { Origin: SITE, "Content-Type": "application/json", ...headers },
  });

const cookieOf = (id: string, state = "granted") => `${COOKIE_NAME}=s=${state}&v=2026-10-01&id=${id}`;

function setCookie(res: TestResponse): string | undefined {
  return res.headers["set-cookie"];
}

/** ioredis が接続断・タイムアウト・応答エラーで投げる代表的なメッセージ */
const VALKEY_FAILURES = [
  ["コマンドのタイムアウト", "Command timed out"],
  ["接続断", "Connection is closed."],
  ["オフラインキューなしで未接続", "Stream isn't writeable and enableOfflineQueue options is false"],
  ["認証エラー", "NOAUTH Authentication required."],
  ["フェイルオーバー中の読み取り専用", "READONLY You can't write against a read only replica."],
] as const;

/** stderr に出たすべての文字列 */
const stderrText = () => stderr.mock.calls.flat().map(String).join("\n");

/** Set-Cookie から識別子を取り出す */
function issuedId(res: TestResponse): string {
  const value = setCookie(res)!.split("; ")[0]!.slice(COOKIE_NAME.length + 1);
  return new URLSearchParams(value).get("id")!;
}

describe("ルーティングと共通の応答ヘッダー", () => {
  describe("正常系", () => {
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

    it("クエリ文字列が付いていても同じパスとして扱う", async () => {
      const res = await send({ path: "/v1/consent?x=1", headers: { Origin: SITE } });
      expect(res.status).toBe(200);
    });

  });

  describe("異常系", () => {
    it("入力: 知らないパスは 404 not_found", async () => {
      const res = await send({ path: "/v1/consent/extra" });
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "not_found" });
    });

    it.each(["/v1/consent/", "/V1/CONSENT", "/v1//consent", "/v1/consent%2F", "/healthz/"])(
      "入力: 似ているが違うパス（%s）は 404 で、Valkey に触れない",
      async (path) => {
        const res = await send({ path, headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
        expect(res.status).toBe(404);
        expect(redis.calls).toEqual([]);
      },
    );

    it("空入力: パスが / だけなら 404", async () => {
      const res = await send({ path: "/" });
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "not_found" });
    });

    it("サーバ: パスが URL として解釈できなければ（//[）、例外を投げず 500 internal", async () => {
      const res = await send({ path: "//[" });
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: "internal" });
      expect(redis.calls).toEqual([]);
    });
  });
});

describe("GET /healthz", () => {
  describe("正常系", () => {
    it("GET と HEAD に 200 を返す", async () => {
      const get = await send({ path: "/healthz" });
      expect(get.status).toBe(200);
      expect(get.json).toEqual({ ok: true });
      const head = await send({ path: "/healthz", method: "HEAD" });
      expect(head.status).toBe(200);
    });

    it("空入力: 記録が 1 件も無くても 200", async () => {
      const res = await send({ path: "/healthz" });
      expect(res.status).toBe(200);
      expect(redis.streams.size).toBe(0);
    });
  });

  describe("異常系", () => {
    it("サーバ: Valkey を見ない（落ちていても 200。瞬断でタスクが ALB から外れないように）", async () => {
      redis.fail = { exec: new Error("down"), xadd: new Error("down"), xrevrange: new Error("down") };
      const res = await send({ path: "/healthz" });
      expect(res.status).toBe(200);
      expect(redis.calls).toEqual([]);
    });

    it("入力: GET・HEAD 以外は 405 で、Allow を返す", async () => {
      const res = await send({ path: "/healthz", method: "POST" });
      expect(res.status).toBe(405);
      expect(res.json).toEqual({ error: "method_not_allowed" });
      expect(res.headers.allow).toBe("GET, HEAD");
    });
  });
});

describe("CORS", () => {
  describe("正常系", () => {
    it("SITE_URL と一致するオリジンにだけ、資格情報つきで許可を返す（* は使わない）", async () => {
      const res = await send({ headers: { Origin: SITE } });
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
      expect(res.headers.vary).toBe("Origin");
    });

    it("空入力: Origin が無い GET には許可のヘッダーを付けないが、Vary: Origin は付ける", async () => {
      const res = await send({});
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(res.headers.vary).toBe("Origin");
    });

    it("SITE_URL にパスが付いた設定でも、オリジンで照合する（設定側で正規化済みの値を使う）", async () => {
      start(makeConfig({ SITE_URL: "http://localhost:4321" }));
      const res = await send({ headers: { Origin: "http://localhost:4321" } });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4321");
    });
  });

  describe("異常系", () => {
    it.each([
      ["別サイト", OTHER_SITE],
      ["http と https の違い", "http://comegin.com"],
      ["サブドメイン", "https://consent.comegin.com"],
      ["末尾のスラッシュ", `${SITE}/`],
      ["null オリジン", "null"],
      ["大文字", "HTTPS://COMEGIN.COM"],
      ["明示したポート", `${SITE}:443`],
      ["サイト名を接頭辞に持つ別ドメイン", `${SITE}.evil.example`],
      ["カンマで並べた複数のオリジン", `${SITE}, ${OTHER_SITE}`],
    ])("入力: %s のオリジンには許可を返さない", async (_label, origin) => {
      const res = await send({ headers: { Origin: origin } });
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("空入力: Origin が空文字なら（GET でも）403 で、記録を読まない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      const res = await send({ headers: { Origin: "", Cookie: cookieOf(EXISTING_ID) } });
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(redis.calls).toEqual([]);
    });

    it.each(["PUT", "DELETE", "PATCH", "HEAD"])("入力: %s は 405 で、Allow: GET, POST, OPTIONS を返す", async (method) => {
      const res = await send({ method, headers: { Origin: SITE } });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET, POST, OPTIONS");
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });

    it("入力: 別のオリジンからの PUT は 405 で、許可のヘッダーを付けず、記録しない", async () => {
      const res = await send({ method: "PUT", body: '{"state":"granted"}', headers: { Origin: OTHER_SITE } });
      expect(res.status).toBe(405);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(redis.calls).toEqual([]);
    });
  });
});

describe("OPTIONS /v1/consent（プリフライト）", () => {
  describe("正常系", () => {
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
  });

  describe("異常系", () => {
    it("入力: ほかのオリジンには 403 origin_not_allowed", async () => {
      const res = await send({ method: "OPTIONS", headers: { Origin: OTHER_SITE } });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    });

    it("空入力: Origin が無ければ 403", async () => {
      const res = await send({ method: "OPTIONS" });
      expect(res.status).toBe(403);
    });

    it("空入力: Origin が空文字でも 403 で、許可のメソッドを返さない", async () => {
      const res = await send({ method: "OPTIONS", headers: { Origin: "" } });
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    });
  });
});

describe("POST /v1/consent", () => {
  describe("正常系", () => {
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

    it("前後に空白のある JSON も受け付ける", async () => {
      const res = await post('  \n{"state":"denied"}\n  ');
      expect(res.status).toBe(201);
    });

    it("空入力: Cookie が無ければ、毎回新しい識別子を発行する", async () => {
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

    it("1 つの識別子の記録が 199 件なら、まだ積める", async () => {
      redis.seed(keyOf(EXISTING_ID), ...Array.from({ length: 199 }, () => STORED));
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(201);
      expect(redis.records(keyOf(EXISTING_ID))).toHaveLength(200);
    });

    it("COOKIE_DOMAIN が空の設定（開発）では Domain を付けない", async () => {
      start(makeConfig({ SITE_URL: "http://localhost:4321", COOKIE_DOMAIN: "" }));
      const res = await post('{"state":"granted"}', { Origin: "http://localhost:4321" });
      expect(res.status).toBe(201);
      expect(setCookie(res)!.toLowerCase()).not.toContain("domain=");
    });
  });

  describe("異常系", () => {
    it("空入力: Origin が無ければ 403（書き込みは必ず公開サイトから）", async () => {
      const res = await send({
        method: "POST",
        body: '{"state":"granted"}',
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(redis.calls).toEqual([]);
    });

    it("空入力: Origin が空文字でも 403 で、記録も Cookie も作らない", async () => {
      const res = await post('{"state":"granted"}', { Origin: "" });
      expect(res.status).toBe(403);
      expect(setCookie(res)).toBeUndefined();
      expect(redis.calls).toEqual([]);
    });

    it("入力: 別のオリジンからは 403 で、記録も Cookie も作らない", async () => {
      const res = await post('{"state":"granted"}', { Origin: OTHER_SITE });
      expect(res.status).toBe(403);
      expect(setCookie(res)).toBeUndefined();
      expect(redis.streams.size).toBe(0);
    });

    it("入力: 別のオリジンからは、発行済みの Cookie が付いていても 403 で、既存の記録を読み書きしない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      const res = await post('{"state":"denied"}', { Origin: OTHER_SITE, Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(403);
      expect(redis.calls).toEqual([]);
      expect(redis.records(keyOf(EXISTING_ID))).toEqual([STORED]);
    });

    it.each([undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
      "入力: Content-Type が %s なら 415 unsupported_media_type",
      async (contentType) => {
        const headers: Record<string, string> = { Origin: SITE };
        if (contentType) headers["Content-Type"] = contentType;
        const res = await send({ method: "POST", body: '{"state":"granted"}', headers });
        expect(res.status).toBe(415);
        expect(res.json).toEqual({ error: "unsupported_media_type" });
        expect(res.headers["access-control-allow-origin"]).toBe(SITE);
      },
    );

    it.each(["application/json-patch+json", "application/jsonx", "text/json", "application/ json"])(
      "入力: application/json に似た Content-Type（%s）も 415 で、記録しない",
      async (contentType) => {
        const res = await post('{"state":"granted"}', { "Content-Type": contentType });
        expect(res.status).toBe(415);
        expect(redis.calls).toEqual([]);
      },
    );

    it("空入力: Content-Type が空文字なら 415", async () => {
      const res = await post('{"state":"granted"}', { "Content-Type": "" });
      expect(res.status).toBe(415);
      expect(res.json).toEqual({ error: "unsupported_media_type" });
    });

    it.each(["{", "state=granted", '{"state":"granted"}x'])("入力: JSON として読めない本文（%j）は 400 invalid_json", async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_json" });
    });

    it.each(["", "   ", "\n"])("空入力: 本文が空・空白だけ（%j）なら 400 invalid_json で、記録しない", async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_json" });
      expect(redis.calls).toEqual([]);
    });

    it("入力: 先頭に BOM の付いた JSON は 400 invalid_json", async () => {
      const res = await post('\uFEFF{"state":"granted"}');
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_json" });
    });

    it("入力: UTF-8 として読めないバイト列は 400 invalid_json で、記録しない", async () => {
      const res = await send({
        method: "POST",
        body: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_json" });
      expect(redis.calls).toEqual([]);
    });

    it.each([
      ["state が想定外", { state: "unset" }],
      ["state が大文字", { state: "GRANTED" }],
      ["state が前後に空白を持つ", { state: " granted " }],
      ["state が数値", { state: 1 }],
      ["state が真偽値", { state: true }],
      ["state が配列", { state: ["granted"] }],
      ["state が入れ子のオブジェクト", { state: { value: "granted" } }],
      ["識別子を送ってくる", { state: "granted", id: EXISTING_ID }],
      ["ポリシーの版を送ってくる", { state: "granted", policy_version: "2099-01-01" }],
      ["時刻を送ってくる", { state: "granted", recorded_at: "2000-01-01T00:00:00Z" }],
      ["配列", ["granted"]],
      ["null", null],
      ["文字列", "granted"],
      ["数値", 0],
    ])("入力: 本文が不正（%s）なら 400 invalid_body で、記録しない", async (_label, body) => {
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
      expect(setCookie(res)).toBeUndefined();
      expect(redis.streams.size).toBe(0);
    });

    it.each([
      ["空のオブジェクト", {}],
      ["state が空文字", { state: "" }],
      ["state が null", { state: null }],
    ])("空入力: 本文が%sなら 400 invalid_body で、記録しない", async (_label, body) => {
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
      expect(redis.calls).toEqual([]);
    });

    it.each([
      ["__proto__ に state を隠す", '{"__proto__":{"state":"granted"}}'],
      ["state の横に __proto__ を足す", '{"state":"granted","__proto__":{"admin":true}}'],
      ["state の横に constructor を足す", '{"state":"granted","constructor":{"prototype":{"x":1}}}'],
    ])("入力: プロトタイプを汚す本文（%s）は 400 invalid_body で、記録しない", async (_label, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
      expect(redis.calls).toEqual([]);
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
    });

    it("入力: 1 KiB に収まる深い入れ子の本文も 400 invalid_body で、落ちない", async () => {
      const nested = `${"[".repeat(400)}${"]".repeat(400)}`;
      const res = await post(`{"state":"granted","x":${nested}}`);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "invalid_body" });
    });

    it("入力: 宣言された Content-Length が 1 KiB を超えれば、本文を見ずに 413（CORS のヘッダーは付ける）", async () => {
      const res = await send({
        method: "POST",
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": "4096" },
      });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(res.headers.connection).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });

    it("入力: 宣言された Content-Length が極端に大きくても（1 GiB）、本文を待たずに 413", async () => {
      const res = await send({
        method: "POST",
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": String(1024 ** 3) },
      });
      expect(res.status).toBe(413);
      expect(redis.calls).toEqual([]);
    });

    it("入力: Content-Length が無くても、本文が 1 KiB を超えれば 413", async () => {
      const res = await send({
        method: "POST",
        body: `{"state":"granted","pad":"${"x".repeat(1100)}"}`,
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(413);
      expect(res.json).toEqual({ error: "payload_too_large" });
      expect(redis.streams.size).toBe(0);
    });

    it("入力: 本文はちょうど 1024 バイトまで受け付け、1025 バイトは 413", async () => {
      const base = '{"state":"granted"}';
      const exact = base + " ".repeat(1024 - base.length);
      expect((await post(exact)).status).toBe(201);
      expect((await post(`${exact} `)).status).toBe(413);
    });

    it("入力: 本文の上限は文字数ではなくバイト数で数える（多バイト文字で 1 KiB を超えれば 413）", async () => {
      const res = await post(`{"state":"granted","pad":"${"あ".repeat(400)}"}`);
      expect(res.status).toBe(413);
      expect(redis.calls).toEqual([]);
    });

    it("入力: Cookie の識別子が形式に合っていても未発行なら引き継がず、新しく発行する", async () => {
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(UNKNOWN_ID) });
      expect(res.status).toBe(201);
      const id = issuedId(res);
      expect(id).not.toBe(UNKNOWN_ID);
      expect(redis.streams.has(keyOf(UNKNOWN_ID))).toBe(false);
      expect(redis.streams.has(keyOf(id))).toBe(true);
    });

    it("入力: Cookie の識別子の形式が不正なら Valkey に問い合わせず、新しく発行する", async () => {
      const res = await post('{"state":"granted"}', { Cookie: `${COOKIE_NAME}=s=granted&id=../../etc` });
      expect(res.status).toBe(201);
      expect(issuedId(res)).toMatch(ID_PATTERN);
      expect(redis.calls.map((call) => call.command)).toEqual(["xadd"]);
    });

    it("入力: 本文で識別子を送っても、Cookie の識別子にも新しい識別子にも使わない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      const res = await post(JSON.stringify({ state: "granted", id: EXISTING_ID }));
      expect(res.status).toBe(400);
      expect(redis.records(keyOf(EXISTING_ID))).toEqual([STORED]);
    });

    it("入力: 200 件に達していれば 429 too_many_records で、記録も Cookie も書かず、既存の記録を消さない", async () => {
      redis.seed(keyOf(EXISTING_ID), ...Array.from({ length: 200 }, () => STORED));
      const res = await post('{"state":"denied"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(429);
      expect(res.json).toEqual({ error: "too_many_records" });
      expect(setCookie(res)).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
      expect(redis.records(keyOf(EXISTING_ID))).toHaveLength(200);
      expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
    });

    it("入力: 上限を超えて積まれていても（201 件）429 で、新しい識別子に逃がさない", async () => {
      redis.seed(keyOf(EXISTING_ID), ...Array.from({ length: 201 }, () => STORED));
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(429);
      expect(redis.streams.size).toBe(1);
    });

    it("サーバ: Valkey に書けなければ 503 unavailable で、Cookie を書かない", async () => {
      redis.fail.xadd = new Error("Command timed out");
      const res = await post('{"state":"granted"}');
      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: "unavailable" });
      expect(setCookie(res)).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });

    it.each(VALKEY_FAILURES)(
      "サーバ: 書き込みが %s（%s）で失敗したら 503 で、本文に失敗理由を出さない",
      async (_label, message) => {
        redis.fail.xadd = new Error(message);
        const res = await post('{"state":"granted"}');
        expect(res.status).toBe(503);
        expect(res.json).toEqual({ error: "unavailable" });
        expect(res.text).not.toContain(message);
        expect(setCookie(res)).toBeUndefined();
      },
    );

    it("サーバ: 識別子の確認（inspect）で Valkey に届かなくても 503 で、Cookie を書かない", async () => {
      redis.fail.exec = new Error("Connection is closed.");
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(503);
      expect(setCookie(res)).toBeUndefined();
      expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
    });

    it("サーバ: 識別子の確認で XLEN だけが失敗しても 503 で、新しい識別子に逃がさない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      redis.fail.xlen = new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(503);
      expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
      expect(redis.streams.size).toBe(1);
    });

    it("サーバ: 識別子の確認が結果なし（exec が null）なら 503 で、新しい識別子に逃がさない", async () => {
      redis.execReturnsNull = true;
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(503);
      expect(redis.calls.some((call) => call.command === "xadd")).toBe(false);
    });

    it("サーバ: 発行済みの識別子への書き込みが失敗しても、既存の記録は消えず Cookie も書かない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      redis.fail.xadd = new Error("READONLY You can't write against a read only replica.");
      const res = await post('{"state":"denied"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(503);
      expect(setCookie(res)).toBeUndefined();
      expect(redis.records(keyOf(EXISTING_ID))).toEqual([STORED]);
    });

    it("サーバ: 遅れて返るタイムアウトでも 503 で、Cookie を書かない", async () => {
      redis.xadd = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Command timed out")), 20));
      const res = await post('{"state":"granted"}');
      expect(res.status).toBe(503);
      expect(setCookie(res)).toBeUndefined();
    });

    it("サーバ: Valkey が復旧すれば、次のリクエストは記録できる", async () => {
      redis.fail.xadd = new Error("Connection is closed.");
      expect((await post('{"state":"granted"}')).status).toBe(503);
      redis.fail = {};
      const res = await post('{"state":"granted"}');
      expect(res.status).toBe(201);
      expect(redis.records(keyOf(issuedId(res)))).toHaveLength(1);
    });

    it("サーバ: 503 のログに Valkey の失敗理由を出す", async () => {
      redis.fail.xadd = new Error("Command timed out");
      await post('{"state":"granted"}');
      expect(stderr).toHaveBeenCalledWith("[store] Valkey is unavailable: Command timed out");
    });

    it("サーバ: Error でない値で失敗しても 503 で、ログの理由は unknown にする", async () => {
      redis.xadd = async () => {
        throw "ECONNRESET";
      };
      const res = await post('{"state":"granted"}');
      expect(res.status).toBe(503);
      expect(stderr).toHaveBeenCalledWith("[store] Valkey is unavailable: unknown");
    });

    it("サーバ: 503 のときもログに識別子を出さない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      redis.fail.xadd = new Error("Command timed out");
      const res = await post('{"state":"granted"}', { Cookie: cookieOf(EXISTING_ID) });
      expect(res.status).toBe(503);
      await vi.waitFor(() => expect(stderrText()).toContain('"status":503'));
      expect(stderrText()).not.toContain(EXISTING_ID);
    });

    it("サーバ: ストアの想定外の例外は 500 internal（詳細を返さない）", async () => {
      const broken = {
        inspect: vi.fn(),
        latest: vi.fn(),
        append: vi.fn().mockRejectedValue(new TypeError("boom: internal detail")),
      } as unknown as ConsentStore;
      start(makeConfig(), broken);
      const res = await post('{"state":"granted"}');
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: "internal" });
      expect(res.text).not.toContain("boom");
      expect(setCookie(res)).toBeUndefined();
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });
  });
});

describe("GET /v1/consent", () => {
  describe("正常系", () => {
    it("空入力: Cookie が無ければ unset（Valkey に問い合わせない）", async () => {
      const res = await send({ headers: { Origin: SITE } });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state: "unset" });
      expect(redis.calls).toEqual([]);
    });

    it("空入力: Cookie ヘッダーが空文字なら unset（Valkey に問い合わせない）", async () => {
      const res = await send({ headers: { Origin: SITE, Cookie: "" } });
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

    it("空入力: Stream の無い識別子は unset", async () => {
      const res = await send({ headers: { Cookie: cookieOf(UNKNOWN_ID) } });
      expect(res.json).toEqual({ state: "unset" });
    });

    it("Origin が無い GET も受け付ける", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      const res = await send({ headers: { Cookie: cookieOf(EXISTING_ID) } });
      expect(res.status).toBe(200);
      expect((res.json as { state: string }).state).toBe("granted");
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
  });

  describe("異常系", () => {
    it("入力: 形式が不正な識別子は unset（Valkey に問い合わせない）", async () => {
      const res = await send({ headers: { Cookie: `${COOKIE_NAME}=s=granted&id=*` } });
      expect(res.json).toEqual({ state: "unset" });
      expect(redis.calls).toEqual([]);
    });

    it("入力: Valkey のキーを組み替えようとする識別子（* や :）は Valkey に渡さない", async () => {
      for (const id of ["*", "a:b", "AAAAAAAAAAAAAAAAAAAAA*", "AAAAAAAAAAAAAAAAAAAAA:"]) {
        const res = await send({ headers: { Cookie: `${COOKIE_NAME}=id=${encodeURIComponent(id)}` } });
        expect(res.json).toEqual({ state: "unset" });
      }
      expect(redis.calls).toEqual([]);
    });

    it("入力: Origin が SITE_URL と違えば 403 で、記録を読まない", async () => {
      redis.seed(keyOf(EXISTING_ID), STORED);
      const res = await send({ headers: { Origin: OTHER_SITE, Cookie: cookieOf(EXISTING_ID) } });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "origin_not_allowed" });
      expect(redis.calls).toEqual([]);
    });

    it("サーバ: Valkey が読めなければ 503 unavailable", async () => {
      redis.fail.xrevrange = new Error("Command timed out");
      const res = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
      expect(res.status).toBe(503);
      expect(res.json).toEqual({ error: "unavailable" });
      expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    });

    it.each(VALKEY_FAILURES)(
      "サーバ: 読み取りが %s（%s）で失敗したら 503 で、unset と取り違えず、本文に失敗理由を出さない",
      async (_label, message) => {
        redis.fail.xrevrange = new Error(message);
        const res = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
        expect(res.status).toBe(503);
        expect(res.json).toEqual({ error: "unavailable" });
        expect(res.text).not.toContain(message);
        expect(setCookie(res)).toBeUndefined();
      },
    );

    it("サーバ: XREVRANGE が配列でない応答を返したら 503（unset と取り違えない）", async () => {
      redis.xrevrange = async () => null as never;
      const res = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
      expect(res.status).toBe(503);
    });

    it("サーバ: 最新の記録が壊れていれば unset を返し、壊れた値を返さない", async () => {
      redis.seed(keyOf(EXISTING_ID), { state: "<script>", at: STORED.at, policy: STORED.policy });
      const res = await send({ headers: { Origin: SITE, Cookie: cookieOf(EXISTING_ID) } });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state: "unset" });
    });
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

  describe("正常系", () => {
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
      const output = stderrText();
      expect(output).not.toContain(EXISTING_ID);
      expect(output).not.toContain("127.0.0.1");
    });

    it("ログは handle が返る前に出す（入口を問わず 1 件 1 行）", async () => {
      await send({ headers: { Origin: SITE } });
      const lines = stderr.mock.calls.map((args) => args[0]).filter((arg) => typeof arg === "string" && arg.startsWith('{"t":'));
      expect(lines).toHaveLength(1);
    });
  });

  describe("異常系", () => {
    it("入力: クエリ文字列に入れた値はログに出さない", async () => {
      await send({ path: `/v1/consent?id=${EXISTING_ID}&email=a%40example.com`, headers: { Origin: SITE } });
      const log = await accessLog();
      expect(log.path).toBe("/v1/consent");
      expect(stderrText()).not.toContain(EXISTING_ID);
      expect(stderrText()).not.toContain("example.com");
    });

    it("入力: 拒否した応答（403）もステータスつきで 1 行出す", async () => {
      await post('{"state":"granted"}', { Origin: OTHER_SITE });
      const log = await accessLog();
      expect(log).toMatchObject({ method: "POST", path: "/v1/consent", status: 403 });
    });
  });
});
