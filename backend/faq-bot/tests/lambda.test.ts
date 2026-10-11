import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";
import { createLambdaHandler, loadSecrets, toRequest } from "../src/lambda.js";

const EVENT = {
  rawPath: "/webhook",
  headers: { "x-chatwoot-timestamp": "1", "X-Chatwoot-Signature": "sha256=00" },
  body: '{"a":1}',
  isBase64Encoded: false,
  requestContext: { http: { method: "POST" } },
};

const secrets = (values: Record<string, string | undefined | Error>) =>
  ({
    send: vi.fn(async (command: { input: { SecretId: string } }) => {
      const value = values[command.input.SecretId];
      if (value instanceof Error) throw value;
      return { SecretString: value };
    }),
  }) as unknown as SecretsManagerClient;

describe("toRequest", () => {
  describe("正常系", () => {
    it("関数 URL のイベントを要求に変え、ヘッダー名を小文字にする", () => {
      const req = toRequest(EVENT);
      expect(req).toMatchObject({ method: "POST", path: "/webhook", headers: { "x-chatwoot-timestamp": "1", "x-chatwoot-signature": "sha256=00" } });
      expect(req.body.toString()).toBe('{"a":1}');
    });

    it("base64 の本文を戻す", () => {
      expect(toRequest({ ...EVENT, body: Buffer.from("あ").toString("base64"), isBase64Encoded: true }).body.toString()).toBe("あ");
    });

    it("空入力: 空のイベントは GET / と空の本文", () => {
      expect(toRequest({})).toEqual({ method: "GET", path: "/", headers: {}, body: Buffer.alloc(0) });
    });
  });
});

describe("loadSecrets", () => {
  describe("正常系", () => {
    it("接頭辞の下の 2 つの Secret を読む", async () => {
      const client = secrets({ "comegin/prod/faq-bot/CHATWOOT_BOT_TOKEN": "tok", "comegin/prod/faq-bot/CHATWOOT_BOT_SECRET": "sec" });
      expect(await loadSecrets(client, "comegin/prod/faq-bot")).toEqual({ token: "tok", secret: "sec" });
    });
  });

  describe("異常系", () => {
    it("空入力: 接頭辞が空なら例外", async () => {
      await expect(loadSecrets(secrets({}), "")).rejects.toThrow("SECRETS_PREFIX");
    });

    it("サーバ: 値の無い Secret は名前だけを出して例外", async () => {
      const client = secrets({ "p/CHATWOOT_BOT_TOKEN": "tok", "p/CHATWOOT_BOT_SECRET": undefined });
      await expect(loadSecrets(client, "p")).rejects.toThrow("p/CHATWOOT_BOT_SECRET");
    });

    it("サーバ: Secrets Manager の例外はそのまま投げる", async () => {
      const denied = Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
      await expect(loadSecrets(secrets({ "p/CHATWOOT_BOT_TOKEN": denied, "p/CHATWOOT_BOT_SECRET": "s" }), "p")).rejects.toMatchObject({ name: "AccessDeniedException" });
    });
  });
});

describe("createLambdaHandler", () => {
  describe("正常系", () => {
    it("初期化は 1 回だけで、応答を関数 URL の形で返す", async () => {
      const handle = vi.fn(async () => ({ status: 200, body: '{"result":"done"}' }));
      const init = vi.fn(async () => handle);
      const lambda = createLambdaHandler(init);
      await lambda(EVENT);
      expect(await lambda(EVENT)).toEqual({
        statusCode: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        body: '{"result":"done"}',
      });
      expect(init).toHaveBeenCalledTimes(1);
    });

    it("空入力: 空のイベントも handle に渡す", async () => {
      const handle = vi.fn(async () => ({ status: 404, body: "{}" }));
      expect((await createLambdaHandler(async () => handle)({})).statusCode).toBe(404);
    });
  });

  describe("異常系", () => {
    it("サーバ: 初期化に失敗したら例外にし、次の呼び出しで初期化をやり直す", async () => {
      const init = vi.fn().mockRejectedValueOnce(new Error("AccessDenied")).mockResolvedValueOnce(async () => ({ status: 200, body: "{}" }));
      const lambda = createLambdaHandler(init);
      await expect(lambda(EVENT)).rejects.toThrow("AccessDenied");
      expect((await lambda(EVENT)).statusCode).toBe(200);
      expect(init).toHaveBeenCalledTimes(2);
    });

    it("サーバ: handle の例外はそのまま投げる（Errors に数え、関数 URL は 502）", async () => {
      const lambda = createLambdaHandler(async () => async () => {
        throw new Error("Chatwoot に届かない");
      });
      await expect(lambda(EVENT)).rejects.toThrow("Chatwoot に届かない");
    });
  });
});
