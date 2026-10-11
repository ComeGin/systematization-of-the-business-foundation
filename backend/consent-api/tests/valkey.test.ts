import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createValkey } from "../src/valkey.js";
import { makeConfig } from "./helpers/config.js";

// 実接続しないよう、ioredis の Redis を EventEmitter だけの偽物に差し替える
const { instances } = vi.hoisted(() => ({
  instances: [] as Array<{ url: string; options: Record<string, unknown> }>,
}));
vi.mock("ioredis", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Redis extends Emitter {
    constructor(url: string, options: Record<string, unknown>) {
      super();
      instances.push({ url, options });
    }
  }
  return { Redis, default: Redis };
});

let stderr: MockInstance<typeof console.error>;

beforeEach(() => {
  instances.length = 0;
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createValkey", () => {
  describe("正常系", () => {
    it("VALKEY_URL に接続し、VALKEY_PASSWORD を AUTH に使う", () => {
      createValkey(makeConfig({ VALKEY_URL: "rediss://cache.example:6379", VALKEY_PASSWORD: "auth-token" }));
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("rediss://cache.example:6379");
      expect(instances[0]!.options.password).toBe("auth-token");
    });

    it("空入力: パスワードが未設定なら password は undefined（認証なし）", () => {
      createValkey(makeConfig({ VALKEY_PASSWORD: undefined }));
      expect(instances[0]!.options.password).toBeUndefined();
    });

    it("接続できないときにコマンドを溜めず、すぐ失敗させる（API が 503 を返すため）", () => {
      createValkey(makeConfig());
      const { options } = instances[0]!;
      expect(options.enableOfflineQueue).toBe(false);
      expect(options.maxRetriesPerRequest).toBe(1);
    });

    it("コマンドは 2 秒でタイムアウトさせる（README: 2 秒以内に返らなければ 503）", () => {
      createValkey(makeConfig());
      const { options } = instances[0]!;
      expect(options.commandTimeout).toBe(2_000);
      expect(typeof options.connectTimeout).toBe("number");
    });

    it("作っただけではログを出さない", () => {
      createValkey(makeConfig());
      expect(stderr).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: error イベントで落ちず、メッセージを stderr に出す", () => {
      const client = createValkey(makeConfig()) as unknown as EventEmitter;
      expect(() => client.emit("error", new Error("connect ECONNREFUSED"))).not.toThrow();
      expect(stderr).toHaveBeenCalledWith("[valkey] connect ECONNREFUSED");
    });

    it.each([
      "connect ETIMEDOUT",
      "getaddrinfo ENOTFOUND master.example.cache.amazonaws.com",
      "read ECONNRESET",
      "WRONGPASS invalid username-password pair or user is disabled.",
    ])("サーバ: 接続の失敗（%s）でも落ちず、メッセージだけを出す", (message) => {
      const client = createValkey(makeConfig()) as unknown as EventEmitter;
      expect(() => client.emit("error", new Error(message))).not.toThrow();
      expect(stderr).toHaveBeenCalledWith(`[valkey] ${message}`);
    });

    it("サーバ: エラーのログに VALKEY_PASSWORD と接続先の URL を出さない", () => {
      const client = createValkey(
        makeConfig({ VALKEY_URL: "rediss://cache.example:6379", VALKEY_PASSWORD: "auth-token-should-not-leak" }),
      ) as unknown as EventEmitter;
      client.emit("error", new Error("WRONGPASS invalid username-password pair or user is disabled."));
      const output = stderr.mock.calls.flat().map(String).join("\n");
      expect(output).not.toContain("auth-token-should-not-leak");
      expect(output).not.toContain("rediss://cache.example:6379");
    });

    it("空入力: メッセージが空のエラーでも落ちない", () => {
      const client = createValkey(makeConfig()) as unknown as EventEmitter;
      expect(() => client.emit("error", new Error(""))).not.toThrow();
      expect(stderr).toHaveBeenCalledWith("[valkey] ");
    });

    it("サーバ: 30 秒以内に続いたエラーは出さず、30 秒たったら再び出す", () => {
      const now = vi.spyOn(Date, "now");
      const client = createValkey(makeConfig()) as unknown as EventEmitter;

      now.mockReturnValue(1_000_000);
      client.emit("error", new Error("first"));
      now.mockReturnValue(1_000_000 + 29_999);
      client.emit("error", new Error("suppressed"));
      now.mockReturnValue(1_000_000 + 30_000);
      client.emit("error", new Error("again"));

      expect(stderr.mock.calls.map((args) => args[0])).toEqual(["[valkey] first", "[valkey] again"]);
    });

    it("サーバ: 再接続のたびにエラーが続いても（30 秒に 1000 回）、ログは 1 行にまとめる", () => {
      const now = vi.spyOn(Date, "now");
      const client = createValkey(makeConfig()) as unknown as EventEmitter;
      for (let i = 0; i < 1_000; i += 1) {
        now.mockReturnValue(1_000_000 + i * 29);
        client.emit("error", new Error("connect ECONNREFUSED"));
      }
      expect(stderr).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 間引きの時刻はクライアントごとに持つ", () => {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const a = createValkey(makeConfig()) as unknown as EventEmitter;
      const b = createValkey(makeConfig()) as unknown as EventEmitter;
      a.emit("error", new Error("a"));
      b.emit("error", new Error("b"));
      expect(stderr).toHaveBeenCalledTimes(2);
    });
  });
});
