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

describe("createValkey: 接続の設定", () => {
  it("VALKEY_URL に接続し、VALKEY_PASSWORD を AUTH に使う", () => {
    createValkey(makeConfig({ VALKEY_URL: "rediss://cache.example:6379", VALKEY_PASSWORD: "auth-token" }));
    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toBe("rediss://cache.example:6379");
    expect(instances[0]!.options.password).toBe("auth-token");
  });

  it("パスワードが未設定なら password は undefined（認証なし）", () => {
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
});

describe("createValkey: エラーのログ", () => {
  it("error イベントで落ちず、メッセージを stderr に出す", () => {
    const client = createValkey(makeConfig()) as unknown as EventEmitter;
    expect(() => client.emit("error", new Error("connect ECONNREFUSED"))).not.toThrow();
    expect(stderr).toHaveBeenCalledWith("[valkey] connect ECONNREFUSED");
  });

  it("30 秒以内に続いたエラーは出さず、30 秒たったら再び出す", () => {
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

  it("間引きの時刻はクライアントごとに持つ", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const a = createValkey(makeConfig()) as unknown as EventEmitter;
    const b = createValkey(makeConfig()) as unknown as EventEmitter;
    a.emit("error", new Error("a"));
    b.emit("error", new Error("b"));
    expect(stderr).toHaveBeenCalledTimes(2);
  });
});
