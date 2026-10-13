import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handle } from "../src/handler.js";
import { createServer } from "../src/server.js";
import { captureStderr } from "./helpers/env.js";

// 開発の入口（Node の http と toNodeHandler）の検査。127.0.0.1 のポート 0 で起動する
let server: http.Server;
let base: string;
let stderr: ReturnType<typeof captureStderr>;

async function start(handle: Handle): Promise<void> {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** node:http で送る（要求ターゲットを fetch が正規化しないように） */
function raw(path: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/`, { method: "GET", path, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(() => {
  stderr = captureStderr();
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("createServer", () => {
  describe("正常系", () => {
    it("handle に x-forwarded-proto と host から組み立てた URL の Request を渡し、応答を書き出す", async () => {
      let received: Request | undefined;
      await start(async (req) => {
        received = req;
        return new Response("hi", { status: 201, headers: { "x-test": "1" } });
      });
      const res = await raw("/sign-in?x=1", { host: "auth.example", "x-forwarded-proto": "https" });
      expect(received!.url).toBe("https://auth.example/sign-in?x=1");
      expect(res.status).toBe(201);
      expect(res.headers["x-test"]).toBe("1");
      expect(res.text).toBe("hi");
    });

    it("複数の Set-Cookie を 1 つずつ書き出す", async () => {
      await start(async () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response(null, { status: 302, headers });
      });
      const res = await raw("/api/auth/callback/google");
      expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    });

    it("keep-alive を 60 秒より長くし、headersTimeout はさらに長くする", async () => {
      await start(async () => new Response("ok"));
      expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
      expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
      expect(server.requestTimeout).toBe(30_000);
    });

    it("空入力: 本文の無い応答も書き出す", async () => {
      await start(async () => new Response(null, { status: 204 }));
      const res = await raw("/");
      expect(res.status).toBe(204);
      expect(res.text).toBe("");
    });
  });

  describe("異常系", () => {
    it("入力: 解釈できない要求ターゲット（//[）は handle を呼ばずに 400 bad request で、クエリを記録しない", async () => {
      const handle = vi.fn<Handle>(async () => new Response("ok"));
      await start(handle);
      const res = await raw("//[?code=SECRETCODE");
      expect(res.status).toBe(400);
      expect(res.text).toBe("bad request");
      expect(handle).not.toHaveBeenCalled();
      expect(stderr.text()).toContain('"status":400');
      expect(stderr.text()).not.toContain("SECRETCODE");
    });

    it("サーバ: handle が投げたら（約束違反）、詳細を出さずに 500 internal error", async () => {
      await start(async () => {
        throw new Error("boom: internal detail");
      });
      const res = await raw("/api/auth/jwks");
      expect(res.status).toBe(500);
      expect(res.text).toBe("internal error");
      expect(stderr.text()).toContain("[server] unexpected error");
    });
  });
});
