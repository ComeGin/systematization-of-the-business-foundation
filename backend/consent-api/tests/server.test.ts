import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { COOKIE_NAME } from "../src/constants.js";
import { createHandler, type Handle, type HttpRequest, type HttpResponse } from "../src/handler.js";
import { createServer } from "../src/server.js";
import { ConsentStore } from "../src/store.js";
import { makeConfig } from "./helpers/config.js";
import { FakeRedis } from "./helpers/fake-redis.js";
import { close, listen, type RequestOptions, request } from "./helpers/http.js";

// 開発の入口（Node の http）の検査。API の振る舞いは handler.test.ts で見る
const SITE = "https://comegin.com";
const EXISTING_ID = "eAd5tbgdBQH8cAOA_oELjQ";

let redis: FakeRedis;
let server: http.Server;
let baseUrl: string;
let stderr: MockInstance<typeof console.error>;

async function start(handle: Handle): Promise<void> {
  server = createServer(handle);
  baseUrl = await listen(server);
}

/** 本物の handler（Valkey だけ偽物）で起動する */
const realHandle = (): Handle => {
  const config = makeConfig();
  return createHandler({ config, store: new ConsentStore(redis.asRedis(), config.VALKEY_KEY_PREFIX) });
};

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  redis = new FakeRedis();
});

afterEach(async () => {
  await close(server);
});

const send = (options: RequestOptions) => request(baseUrl, options);

/** サーバーへの接続がすべて閉じるまで待つ（途中で切られたリクエストの後始末を待つ） */
async function waitForNoConnections(): Promise<void> {
  await vi.waitFor(async () => {
    const count = await new Promise<number>((resolve, reject) =>
      server.getConnections((error, value) => (error ? reject(error) : resolve(value))),
    );
    expect(count).toBe(0);
  });
}

describe("createServer", () => {
  describe("正常系", () => {
    it("handle にメソッド・クエリ付きのパス・小文字のヘッダー・本文を渡し、結果をそのまま書き出す", async () => {
      let received: HttpRequest | undefined;
      await start(async (req) => {
        received = req;
        return { status: 201, headers: { "X-Test": "1", "Set-Cookie": "a=b; Path=/" }, body: '{"ok":true}' };
      });
      const res = await send({
        method: "POST",
        path: "/v1/consent?x=1",
        body: '{"state":"granted"}',
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(received).toMatchObject({ method: "POST", path: "/v1/consent?x=1" });
      expect(received!.headers.origin).toBe(SITE);
      expect(received!.headers["content-type"]).toBe("application/json");
      expect(received!.body.toString("utf8")).toBe('{"state":"granted"}');
      expect(res.status).toBe(201);
      expect(res.headers["x-test"]).toBe("1");
      expect(res.headers["set-cookie"]).toEqual(["a=b; Path=/"]);
      expect(res.json).toEqual({ ok: true });
    });

    it("空入力: 本文の無い GET には空の Buffer を渡す", async () => {
      let received: HttpRequest | undefined;
      await start(async (req) => {
        received = req;
        return { status: 200, headers: {}, body: "" };
      });
      await send({});
      expect(received!.body.length).toBe(0);
    });

    it("本物の handler と組み合わせて、同意を記録して Cookie を返す", async () => {
      await start(realHandle());
      const res = await send({
        method: "POST",
        body: '{"state":"granted"}',
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect(res.headers["set-cookie"]![0]).toMatch(new RegExp(`^${COOKIE_NAME}=s=granted&`));
      expect(redis.streams.size).toBe(1);
    });

    it("keep-alive を 60 秒より長くし、headersTimeout はさらに長くする", async () => {
      await start(realHandle());
      expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
      expect(server.requestTimeout).toBeGreaterThan(0);
    });
  });

  describe("異常系", () => {
    it("入力: 宣言された Content-Length が 1 KiB を超えれば、本文を読まずに 413 で接続を閉じる", async () => {
      await start(realHandle());
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

    it("入力: 宣言された Content-Length が極端に大きくても（1 GiB）、本文を待たずに 413", async () => {
      await start(realHandle());
      const res = await send({
        method: "POST",
        headersOnly: true,
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": String(1024 ** 3) },
      });
      expect(res.status).toBe(413);
      expect(redis.calls).toEqual([]);
    });

    it("入力: Content-Length なし（チャンク）でも 1 KiB を超えた時点で読むのをやめ、413 で接続を閉じる", async () => {
      let size = -1;
      const handle = realHandle();
      await start(async (req) => {
        size = req.body.length;
        return handle(req);
      });
      const res = await send({
        method: "POST",
        chunked: true,
        body: `{"state":"granted","pad":"${"x".repeat(5_000)}"}`,
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(413);
      expect(res.headers.connection).toBe("close");
      // 1 回の write は 1 つのチャンクで届きうるため、上限を超えたことだけを見る（何バイトで止まるかは見ない）
      expect(size).toBeGreaterThan(1024);
      expect(redis.streams.size).toBe(0);
    });

    // 接続断が読み取りの例外になるか、途中までの本文で終わるかは Node の版による。どちらでも記録しないことだけを見る
    it("入力: 本文の途中で接続が切れても記録せず、サーバーは次のリクエストに応える", async () => {
      await start(realHandle());
      const req = http.request(new URL("/v1/consent", baseUrl), {
        method: "POST",
        agent: false,
        headers: { Origin: SITE, "Content-Type": "application/json", "Content-Length": "100" },
      });
      req.on("error", () => {});
      req.write('{"state":"gra');
      await new Promise((resolve) => setTimeout(resolve, 20));
      req.destroy();
      await waitForNoConnections();
      expect(redis.calls).toEqual([]);

      const res = await send({
        method: "POST",
        body: '{"state":"granted"}',
        headers: { Origin: SITE, "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
    });

    it("入力: Cookie ヘッダーが Node の上限（16 KiB）を超えれば 431 で、handle を呼ばない", async () => {
      const handle = vi.fn(realHandle());
      await start(handle);
      const res = await send({
        headers: { Origin: SITE, Cookie: `pad=${"x".repeat(20_000)}; ${COOKIE_NAME}=id=${EXISTING_ID}` },
      });
      expect(res.status).toBe(431);
      expect(handle).not.toHaveBeenCalled();
    });

    it("サーバ: handle が例外を投げたら（約束違反）、詳細を出さずに 500 internal", async () => {
      await start(async () => {
        throw new TypeError("boom: internal detail");
      });
      const res = await send({ headers: { Origin: SITE } });
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ error: "internal" });
      expect(res.text).not.toContain("boom");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(stderr).toHaveBeenCalledWith("[server] unexpected error", expect.any(TypeError));
    });

    it("サーバ: handle の応答が返らなくても、他の接続は受け付ける", async () => {
      let calls = 0;
      await start(async (): Promise<HttpResponse> => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return { status: 200, headers: {}, body: "" };
      });
      void send({}).catch(() => {});
      const res = await send({});
      expect(res.status).toBe(200);
    });
  });
});
