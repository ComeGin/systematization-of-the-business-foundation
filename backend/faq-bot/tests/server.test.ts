import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Handle, HttpRequest } from "../src/handler.js";
import { createDevServer } from "../src/server.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function start(handle: Handle, log = vi.fn()) {
  const server = createDevServer(handle, log);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

describe("createDevServer", () => {
  describe("正常系", () => {
    it("本文とヘッダー（小文字）を渡し、handle の応答を JSON で返す", async () => {
      let received: HttpRequest | null = null;
      const { url } = await start(async (req) => {
        received = req;
        return { status: 200, body: '{"result":"done"}' };
      });
      const res = await fetch(`${url}/webhook?x=1`, { method: "POST", headers: { "X-Chatwoot-Timestamp": "1" }, body: '{"a":1}' });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ result: "done" });
      expect(received).toMatchObject({ method: "POST", path: "/webhook", headers: { "x-chatwoot-timestamp": "1" } });
      expect(received!.body.toString()).toBe('{"a":1}');
    });

    it("空入力: 本文の無い要求も渡す", async () => {
      const handle = vi.fn(async () => ({ status: 200, body: "{}" }));
      const { url } = await start(handle);
      await fetch(`${url}/healthz`);
      expect(handle.mock.calls[0]?.[0].body.length).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: 64 KB を超える本文は 413（handle を呼ばない）", async () => {
      const handle = vi.fn(async () => ({ status: 200, body: "{}" }));
      const { url } = await start(handle);
      const res = await fetch(`${url}/webhook`, { method: "POST", body: "x".repeat(64 * 1024 + 1) });
      expect(res.status).toBe(413);
      expect(handle).not.toHaveBeenCalled();
    });

    it("サーバ: handle の例外は 502（本番の関数 URL と同じ）にし、ログに出す", async () => {
      const { url, log } = await start(async () => {
        throw new Error("Chatwoot に届かない");
      });
      const res = await fetch(`${url}/webhook`, { method: "POST", body: "{}" });
      expect(res.status).toBe(502);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Chatwoot に届かない"));
    });
  });
});
