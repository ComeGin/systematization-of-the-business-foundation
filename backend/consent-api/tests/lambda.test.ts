import { EventEmitter } from "node:events";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { HttpRequest } from "../src/handler.js";
import { type AlbEvent, createLambdaHandler, initRuntime, loadValkeyPassword, type Runtime, toRequest, toResult } from "../src/lambda.js";

// Valkey の接続は偽物にする（実接続しない）。waitReady はテストごとに結果を決める
const mocks = vi.hoisted(() => ({ createValkey: vi.fn(), waitReady: vi.fn() }));
vi.mock("../src/valkey.js", () => ({ createValkey: mocks.createValkey, waitReady: mocks.waitReady }));

const SITE = "https://comegin.com";
const ENV = {
  VALKEY_URL: "rediss://cache.example:6379",
  SITE_URL: SITE,
  COOKIE_DOMAIN: ".comegin.com",
  CONSENT_POLICY_VERSION: "2026-10-01",
  VALKEY_PASSWORD_SECRET_ID: "comegin/prod/shared/VALKEY_AUTH_TOKEN",
};

let stderr: MockInstance<typeof console.error>;
let valkey: EventEmitter & { status: string; disconnect: ReturnType<typeof vi.fn> };

beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  valkey = Object.assign(new EventEmitter(), { status: "ready", disconnect: vi.fn() });
  mocks.createValkey.mockReset().mockReturnValue(valkey);
  mocks.waitReady.mockReset().mockResolvedValue(true);
});

const event = (overrides: Partial<AlbEvent> = {}): AlbEvent => ({
  httpMethod: "GET",
  path: "/v1/consent",
  headers: { origin: SITE },
  body: "",
  isBase64Encoded: false,
  ...overrides,
});

/** handle を差し替えた Runtime（Valkey は偽物） */
const runtimeWith = (handle: Runtime["handle"]): Runtime => ({ handle, valkey: valkey as unknown as Runtime["valkey"] });

describe("toRequest", () => {
  describe("正常系", () => {
    it("メソッド・パス・本文をそのまま渡し、ヘッダー名を小文字にそろえる", () => {
      const req = toRequest(
        event({ httpMethod: "POST", headers: { Origin: SITE, "Content-Type": "application/json" }, body: '{"state":"granted"}' }),
      );
      expect(req).toMatchObject({ method: "POST", path: "/v1/consent" });
      expect(req.headers).toEqual({ origin: SITE, "content-type": "application/json" });
      expect(req.body.toString("utf8")).toBe('{"state":"granted"}');
    });

    it("本文が base64 なら復号して渡す", () => {
      const req = toRequest(event({ body: Buffer.from('{"state":"denied"}').toString("base64"), isBase64Encoded: true }));
      expect(req.body.toString("utf8")).toBe('{"state":"denied"}');
    });

    it("空入力: headers・body・メソッド・パスが無ければ、空のヘッダー・空の本文・GET・/ にする", () => {
      const req = toRequest({ headers: null, body: null });
      expect(req).toEqual({ method: "GET", path: "/", headers: {}, body: Buffer.alloc(0) });
    });
  });

  describe("異常系", () => {
    it("入力: 値が undefined のヘッダーは undefined のまま渡す（文字列にしない）", () => {
      const req = toRequest(event({ headers: { Cookie: undefined } }));
      expect(req.headers.cookie).toBeUndefined();
    });

    it("入力: base64 の印が無い本文は、base64 らしく見えても復号しない", () => {
      const req = toRequest(event({ body: "eyJzdGF0ZSI6ImdyYW50ZWQifQ==", isBase64Encoded: false }));
      expect(req.body.toString("utf8")).toBe("eyJzdGF0ZSI6ImdyYW50ZWQifQ==");
    });
  });
});

describe("toResult", () => {
  describe("正常系", () => {
    it("ステータス・理由句・ヘッダー（Set-Cookie を含む）・本文を ALB の形にする", () => {
      const result = toResult({ status: 201, headers: { "Set-Cookie": "comegin_consent=x", Vary: "Origin" }, body: "{}" });
      expect(result).toEqual({
        statusCode: 201,
        statusDescription: "201 Created",
        headers: { "Set-Cookie": "comegin_consent=x", Vary: "Origin" },
        body: "{}",
        isBase64Encoded: false,
      });
    });

    it("空入力: 本文が空の 204 も、そのまま返す", () => {
      expect(toResult({ status: 204, headers: {}, body: "" })).toMatchObject({ statusCode: 204, statusDescription: "204 No Content", body: "" });
    });
  });

  describe("異常系", () => {
    it("入力: 理由句の無いステータスは数字だけにする", () => {
      expect(toResult({ status: 599, headers: {}, body: "" }).statusDescription).toBe("599");
    });
  });
});

describe("loadValkeyPassword", () => {
  describe("正常系", () => {
    it("Secret の ID で GetSecretValue を呼び、文字列の値を返す", async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: "auth-token" });
      await expect(loadValkeyPassword({ send } as never, "comegin/prod/shared/VALKEY_AUTH_TOKEN")).resolves.toBe("auth-token");
      const command = send.mock.calls[0]![0] as GetSecretValueCommand;
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect(command.input).toEqual({ SecretId: "comegin/prod/shared/VALKEY_AUTH_TOKEN" });
    });
  });

  describe("異常系", () => {
    it("空入力: Secret の ID が空なら、SDK を呼ばずに失敗する", async () => {
      const send = vi.fn();
      await expect(loadValkeyPassword({ send } as never, "")).rejects.toThrow("VALKEY_PASSWORD_SECRET_ID");
      expect(send).not.toHaveBeenCalled();
    });

    it("サーバ: Secret に文字列の値が無ければ失敗し、メッセージに値を含めない", async () => {
      const send = vi.fn().mockResolvedValue({ SecretBinary: new Uint8Array([1]) });
      await expect(loadValkeyPassword({ send } as never, "id")).rejects.toThrow("id に値が無い");
    });

    it("サーバ: SDK の例外（権限・NAT の断）はそのまま投げる", async () => {
      const send = vi.fn().mockRejectedValue(new Error("AccessDeniedException"));
      await expect(loadValkeyPassword({ send } as never, "id")).rejects.toThrow("AccessDeniedException");
    });
  });
});

describe("initRuntime", () => {
  describe("正常系", () => {
    it("読んだパスワードで Valkey を作り、ready を待ってから handle を返す", async () => {
      const runtime = await initRuntime({ env: ENV, loadPassword: async () => "auth-token" });
      expect(mocks.createValkey).toHaveBeenCalledWith(
        expect.objectContaining({ VALKEY_PASSWORD: "auth-token", VALKEY_URL: ENV.VALKEY_URL }),
        expect.anything(),
      );
      expect(mocks.waitReady).toHaveBeenCalledWith(valkey, 3_000);
      expect(runtime.valkey).toBe(valkey);
      const res = await runtime.handle({ method: "GET", path: "/healthz", headers: {}, body: Buffer.alloc(0) });
      expect(res.status).toBe(200);
    });

    it("Valkey に socketTimeout（コマンドのタイムアウトと同じ 2 秒）を付け、無言で消えた接続を壊して再接続させる", async () => {
      await initRuntime({ env: ENV, loadPassword: async () => "auth-token" });
      expect(mocks.createValkey).toHaveBeenCalledWith(expect.anything(), { socketTimeout: 2_000 });
    });

    it("空入力: パスワードが空文字なら認証なし（開発の Valkey）で作る", async () => {
      await initRuntime({ env: ENV, loadPassword: async () => "" });
      expect((mocks.createValkey.mock.calls[0]![0] as { VALKEY_PASSWORD?: string }).VALKEY_PASSWORD).toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("サーバ: 3 秒以内に ready にならなければ、接続を閉じて失敗にする", async () => {
      mocks.waitReady.mockResolvedValue(false);
      await expect(initRuntime({ env: ENV, loadPassword: async () => "auth-token" })).rejects.toThrow("Valkey");
      expect(valkey.disconnect).toHaveBeenCalledTimes(1);
    });

    it("入力: 設定が不正なら、プロセスを終了させずに初期化の失敗（例外）にし、Valkey を作らない", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
      await expect(initRuntime({ env: { ...ENV, SITE_URL: "not-a-url" }, loadPassword: async () => "auth-token" })).rejects.toThrow("SITE_URL");
      expect(exit).not.toHaveBeenCalled();
      expect(mocks.createValkey).not.toHaveBeenCalled();
    });

    it("サーバ: パスワードを読めなければ、Valkey を作らずに失敗する", async () => {
      await expect(
        initRuntime({
          env: ENV,
          loadPassword: async () => {
            throw new Error("ResourceNotFoundException");
          },
        }),
      ).rejects.toThrow("ResourceNotFoundException");
      expect(mocks.createValkey).not.toHaveBeenCalled();
    });

    it("サーバ: 失敗のメッセージとログにパスワードを出さない", async () => {
      mocks.waitReady.mockResolvedValue(false);
      const error = await initRuntime({ env: ENV, loadPassword: async () => "auth-token-should-not-leak" }).catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain("auth-token-should-not-leak");
      expect(stderr.mock.calls.flat().map(String).join("\n")).not.toContain("auth-token-should-not-leak");
    });
  });
});

describe("createLambdaHandler", () => {
  describe("正常系", () => {
    it("ALB のイベントを handle に渡し、結果を ALB の形で返す", async () => {
      let received: HttpRequest | undefined;
      const handler = createLambdaHandler(async () =>
        runtimeWith(async (req) => {
          received = req;
          return { status: 200, headers: { Vary: "Origin" }, body: '{"state":"unset"}' };
        }),
      );
      const result = await handler(event({ headers: { Origin: SITE } }));
      expect(received!.headers.origin).toBe(SITE);
      expect(result).toMatchObject({ statusCode: 200, body: '{"state":"unset"}', isBase64Encoded: false });
    });

    it("初期化は最初の呼び出しの 1 回だけで、以後は同じ handle を使う", async () => {
      const init = vi.fn(async () => runtimeWith(async () => ({ status: 200, headers: {}, body: "" })));
      const handler = createLambdaHandler(init);
      await handler(event());
      await handler(event());
      await handler(event());
      expect(init).toHaveBeenCalledTimes(1);
    });

    it("呼び出しの前に ready でなければ待つ（凍結から戻ったときの再接続）", async () => {
      const handle = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
      const handler = createLambdaHandler(async () => runtimeWith(handle), 3_000);
      await handler(event());
      expect(mocks.waitReady).toHaveBeenCalledWith(valkey, 3_000);
      expect(handle).toHaveBeenCalledTimes(1);
    });

    it("空入力: 本文の無いイベントでも handle を呼ぶ", async () => {
      const handle = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
      const handler = createLambdaHandler(async () => runtimeWith(handle));
      await handler({});
      expect(handle).toHaveBeenCalledWith({ method: "GET", path: "/", headers: {}, body: Buffer.alloc(0) });
    });
  });

  describe("異常系", () => {
    it("サーバ: 初期化に失敗したら例外を投げ（Errors に数え、ALB は 502）、次の呼び出しでやり直す", async () => {
      const init = vi
        .fn<() => Promise<Runtime>>()
        .mockRejectedValueOnce(new Error("Valkey に 3 秒以内に接続できない"))
        .mockResolvedValue(runtimeWith(async () => ({ status: 200, headers: {}, body: "" })));
      const handler = createLambdaHandler(init);
      await expect(handler(event())).rejects.toThrow("Valkey");
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 200 });
      expect(init).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 待っても ready にならなければ、そのまま handle を呼ぶ（handle が 503 を返す）", async () => {
      mocks.waitReady.mockResolvedValue(false);
      const handle = vi.fn(async () => ({ status: 503, headers: {}, body: '{"error":"unavailable"}' }));
      const handler = createLambdaHandler(async () => runtimeWith(handle));
      await expect(handler(event())).resolves.toMatchObject({ statusCode: 503 });
      expect(handle).toHaveBeenCalledTimes(1);
    });
  });
});
