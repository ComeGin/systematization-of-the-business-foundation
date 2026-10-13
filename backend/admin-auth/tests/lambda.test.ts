import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { type AlbEvent, buildRuntime, createLambdaHandler, loadBaseConfig, type Runtime, toRequest, toResult } from "../src/lambda.js";
import { captureStderr, DB_PASSWORD, SECRET, validEnv } from "./helpers/env.js";

const ORIGIN = "https://auth.comegin.com";

const event = (overrides: Partial<AlbEvent> = {}): AlbEvent => ({
  httpMethod: "GET",
  path: "/api/auth/jwks",
  multiValueHeaders: { host: ["auth.comegin.com"] },
  multiValueQueryStringParameters: {},
  body: "",
  isBase64Encoded: false,
  ...overrides,
});

/** handle を差し替えた Runtime。close の呼び出しを数える */
const runtime = (handle: Runtime["handle"]): Runtime & { close: ReturnType<typeof vi.fn> } => ({
  origin: ORIGIN,
  handle,
  close: vi.fn(async () => {}),
});

beforeEach(() => {
  captureStderr();
});

describe("toRequest", () => {
  describe("正常系", () => {
    it("ヘッダーの複数の値をすべて渡し、host から https の URL を組み立てる", () => {
      const req = toRequest(event({ multiValueHeaders: { host: ["auth.comegin.com"], accept: ["text/html"], "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] } }), ORIGIN);
      expect(req.url).toBe("https://auth.comegin.com/api/auth/jwks");
      expect(req.headers.get("accept")).toBe("text/html");
      expect(req.headers.get("x-forwarded-for")).toBe("1.1.1.1, 2.2.2.2");
    });

    it("クエリは ALB がデコードしていないので、再エンコードせずにそのまま戻す（同じキーの複数の値も保つ）", () => {
      const req = toRequest(
        event({
          path: "/api/auth/oauth2/authorize",
          multiValueQueryStringParameters: { redirect_uri: ["https%3A%2F%2Fchat.comegin.com%2Foauth2%2Fidpresponse"], scope: ["openid%20email"], a: ["1", "2"] },
        }),
        ORIGIN,
      );
      expect(req.url).toBe(
        "https://auth.comegin.com/api/auth/oauth2/authorize?redirect_uri=https%3A%2F%2Fchat.comegin.com%2Foauth2%2Fidpresponse&scope=openid%20email&a=1&a=2",
      );
      expect(new URL(req.url).searchParams.get("redirect_uri")).toBe("https://chat.comegin.com/oauth2/idpresponse");
    });

    it("base64 の本文（フォーム形式のトークンの要求）を復号して渡す", async () => {
      const body = "grant_type=authorization_code&code=abc";
      const req = toRequest(
        event({ httpMethod: "POST", path: "/api/auth/oauth2/token", body: Buffer.from(body).toString("base64"), isBase64Encoded: true }),
        ORIGIN,
      );
      expect(await req.text()).toBe(body);
    });

    it("空入力: ヘッダー・クエリ・本文・メソッド・パスが無ければ、BETTER_AUTH_URL のホストで GET / を作る", () => {
      const req = toRequest({ multiValueHeaders: null, multiValueQueryStringParameters: null, body: null }, ORIGIN);
      expect(req.method).toBe("GET");
      expect(req.url).toBe("https://auth.comegin.com/");
      expect(req.body).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: GET に本文が付いたイベントでも、本文は付けない", () => {
      expect(toRequest(event({ body: "x=1" }), ORIGIN).body).toBeNull();
    });

    it("入力: HEAD にも本文を付けない", () => {
      expect(toRequest(event({ httpMethod: "HEAD", body: "x=1" }), ORIGIN).body).toBeNull();
    });
  });
});

describe("toResult", () => {
  describe("正常系", () => {
    it("Set-Cookie を 1 つずつ配列で返し、ほかのヘッダーも配列にする", async () => {
      const headers = new Headers({ location: "https://chat.comegin.com/oauth2/idpresponse?code=x" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      const result = await toResult(new Response(null, { status: 302, headers }));
      expect(result.statusCode).toBe(302);
      expect(result.statusDescription).toBe("302 Found");
      expect(result.multiValueHeaders["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
      expect(result.multiValueHeaders.location).toEqual(["https://chat.comegin.com/oauth2/idpresponse?code=x"]);
    });

    it("JSON・HTML・JavaScript の本文はそのまま、isBase64Encoded は false", async () => {
      for (const type of ["application/json", "text/html; charset=utf-8", "application/javascript", "application/jwk-set+json"]) {
        const result = await toResult(new Response('{"k":"日本"}', { headers: { "content-type": type } }));
        expect(result).toMatchObject({ body: '{"k":"日本"}', isBase64Encoded: false });
      }
    });

    it("空入力: 本文の無い応答は空文字で、isBase64Encoded は false", async () => {
      expect(await toResult(new Response(null, { status: 204 }))).toMatchObject({ body: "", isBase64Encoded: false, statusDescription: "204 No Content" });
    });
  });

  describe("異常系", () => {
    it("入力: 型の無い本文と画像は base64 にする", async () => {
      const bytes = new Uint8Array([0xff, 0x00, 0x10]);
      const result = await toResult(new Response(bytes, { headers: { "content-type": "image/png" } }));
      expect(result).toMatchObject({ body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true });
      const untyped = new Response(bytes);
      untyped.headers.delete("content-type");
      expect((await toResult(untyped)).isBase64Encoded).toBe(true);
    });
  });
});

describe("loadBaseConfig", () => {
  describe("正常系", () => {
    it("秘密値を 3 つ読み、設定に入れて返す。ALB_CLIENT_SECRET は読まない", async () => {
      const readSecret = vi.fn(async (name: string) => `${name}-value-0123456789abcdefghijklmnop`);
      const env = { ...validEnv({ NODE_ENV: "production", GOOGLE_CLIENT_ID: "gid" }), BETTER_AUTH_SECRET: undefined, DATABASE_PASSWORD: undefined };
      const config = await loadBaseConfig(env, readSecret);
      expect(readSecret.mock.calls.map((c) => c[0]).sort()).toEqual(["BETTER_AUTH_SECRET", "DB_PASSWORD", "GOOGLE_CLIENT_SECRET"]);
      expect(config.DATABASE_PASSWORD).toBe("DB_PASSWORD-value-0123456789abcdefghijklmnop");
      expect(config.GOOGLE_CLIENT_SECRET).toBe("GOOGLE_CLIENT_SECRET-value-0123456789abcdefghijklmnop");
    });
  });

  describe("異常系", () => {
    it("サーバ: 秘密値を読めなければ失敗する", async () => {
      await expect(loadBaseConfig(validEnv(), async () => Promise.reject(new Error("AccessDeniedException")))).rejects.toThrow("AccessDeniedException");
    });

    it("入力: 設定が不正なら、プロセスを終了させずに例外にし、値を出さない", async () => {
      const exit = vi.spyOn(process, "exit");
      const error = await loadBaseConfig(validEnv({ DATABASE_HOST: "" }), async () => DB_PASSWORD).catch((e: Error) => e);
      expect((error as Error).message).toContain("DATABASE_HOST");
      expect((error as Error).message).not.toContain(DB_PASSWORD);
      expect(exit).not.toHaveBeenCalled();
    });

    it("空入力: 秘密値が空文字なら、設定の検証で失敗する", async () => {
      await expect(loadBaseConfig(validEnv(), async () => "")).rejects.toThrow("BETTER_AUTH_SECRET");
    });
  });
});

describe("buildRuntime", () => {
  describe("正常系", () => {
    it("Lambda 用のプール（max 2・query_timeout 5 秒）で auth と handle を作り、close でプールを閉じる", async () => {
      const end = vi.fn(async () => {});
      // connect も持たせる（Better Auth は pg の Pool を connect の有無で見分ける。無いとアダプターの判別に失敗して未処理の reject になりうる）
      const makePool = vi.fn(() => ({ end, on: vi.fn(), query: vi.fn(), connect: vi.fn() }) as never);
      const config = parseConfig(validEnv());
      const built = buildRuntime(config, makePool);
      expect(makePool).toHaveBeenCalledWith(config, { max: 2, queryTimeoutMs: 5_000 });
      expect(built.origin).toBe("http://localhost:3103");
      const res = await built.handle(new Request("http://localhost:3103/healthz"));
      expect(res.status).toBe(200);
      await built.close();
      expect(end).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createLambdaHandler", () => {
  const okHandle = async () => new Response("ok", { headers: { "content-type": "text/plain" } });

  describe("正常系", () => {
    it("ALB のイベントを handle に渡し、結果を ALB の形で返す", async () => {
      const handler = createLambdaHandler({ load: async () => "BASE", build: () => runtime(okHandle) });
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200, body: "ok", isBase64Encoded: false });
    });

    it("秘密値と設定の読み込みは 1 回だけ。アイドルが 60 秒未満なら作り直さない", async () => {
      let clock = 1_000_000;
      const load = vi.fn(async () => "BASE");
      const build = vi.fn(() => runtime(okHandle));
      const handler = createLambdaHandler({ load, build, now: () => clock });
      await handler(event());
      clock += 59_999;
      await handler(event());
      expect(load).toHaveBeenCalledTimes(1);
      expect(build).toHaveBeenCalledTimes(1);
    });

    it("60 秒以上空いたら、処理の前にプールと auth を作り直し、古い方を閉じる。秘密値は読み直さない", async () => {
      let clock = 1_000_000;
      const load = vi.fn(async () => "BASE");
      const first = runtime(okHandle);
      const second = runtime(okHandle);
      const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
      const handler = createLambdaHandler({ load, build, now: () => clock });
      await handler(event());
      clock += 60_000;
      await handler(event());
      expect(build).toHaveBeenCalledTimes(2);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("空入力: 項目の無いイベントでも、BETTER_AUTH_URL のホストで処理する", async () => {
      let received: Request | undefined;
      const handler = createLambdaHandler({
        load: async () => "BASE",
        build: () =>
          runtime(async (req) => {
            received = req;
            return new Response("ok");
          }),
      });
      await handler({});
      expect(received!.url).toBe("https://auth.comegin.com/");
    });
  });

  describe("異常系", () => {
    it("サーバ: 読み込みに失敗したら例外を投げ（Errors に数え、ALB は 502）、次の呼び出しでやり直す", async () => {
      const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("AccessDeniedException")).mockResolvedValue("BASE");
      const handler = createLambdaHandler({ load, build: () => runtime(okHandle) });
      await expect(handler(event())).rejects.toThrow("AccessDeniedException");
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 古いプールを閉じるのに失敗しても、処理を続ける", async () => {
      let clock = 0;
      const first = runtime(okHandle);
      first.close.mockRejectedValue(new Error("Connection terminated"));
      const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(runtime(okHandle));
      const handler = createLambdaHandler({ load: async () => "BASE", build, now: () => clock });
      await handler(event());
      clock += 60_000;
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200 });
    });

    it("入力: URL を組み立てられないイベント（不正な host）は、handle を呼ばずに 400 を返す（Errors にしない）", async () => {
      const handle = vi.fn(okHandle);
      const handler = createLambdaHandler({ load: async () => "BASE", build: () => runtime(handle) });
      const result = await handler(event({ multiValueHeaders: { host: ["bad host[]"] } }));
      expect(result.statusCode).toBe(400);
      expect(result.body).toBe("bad request");
      expect(handle).not.toHaveBeenCalled();
    });

    // 秘密値を実際に読み込んだうえで設定の検証に失敗させ、例外とログの両方に値が出ないことを見る
    it("サーバ: 秘密値を読んだあとの設定の失敗でも、例外とログに秘密値を出さない", async () => {
      const stderr = captureStderr();
      const readSecret = async (name: string) => (name === "DB_PASSWORD" ? DB_PASSWORD : SECRET);
      const handler = createLambdaHandler({
        load: () => loadBaseConfig(validEnv({ DATABASE_HOST: "" }), readSecret),
        build: () => runtime(okHandle),
      });
      const error = await handler(event()).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(Error);
      for (const value of [SECRET, DB_PASSWORD]) {
        expect(`${error?.message}\n${error?.stack}`).not.toContain(value);
        expect(stderr.text()).not.toContain(value);
      }
    });
  });
});
