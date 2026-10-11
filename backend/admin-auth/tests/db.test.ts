import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { captureStderr, DB_PASSWORD, validEnv } from "./helpers/env.js";

// pg は偽物の Pool に差し替える（実 DB には繋がない）。作られたプールはテストごとに空にする
const poolInstances: Array<{ options: Record<string, unknown>; handlers: Map<string, (error: Error) => void> }> = [];

vi.mock("pg", () => {
  class Pool {
    handlers = new Map<string, (error: Error) => void>();
    constructor(public options: Record<string, unknown>) {
      poolInstances.push(this);
    }
    on(event: string, handler: (error: Error) => void) {
      this.handlers.set(event, handler);
      return this;
    }
  }
  return { default: { Pool } };
});

const { createPool } = await import("../src/db.js");

beforeEach(() => {
  poolInstances.length = 0;
});

describe("createPool", () => {
  describe("正常系", () => {
    it("設定の接続情報と、プールの上限・接続のタイムアウトを渡す", () => {
      createPool(loadConfig(validEnv({ DATABASE_PORT: "6543", DATABASE_NAME: "aa" })));
      expect(poolInstances[0]?.options).toMatchObject({
        host: "db.invalid",
        port: 6543,
        database: "aa",
        user: "admin_auth",
        password: "db-password-should-not-leak",
        max: 10,
        connectionTimeoutMillis: 5_000,
      });
    });

    it("DATABASE_SSL=true では証明書を検証する", () => {
      createPool(loadConfig(validEnv({ DATABASE_SSL: "true" })));
      expect(poolInstances[0]?.options.ssl).toEqual({ rejectUnauthorized: true });
    });

    it("DATABASE_SSL=false では SSL を使わない", () => {
      createPool(loadConfig(validEnv({ DATABASE_SSL: "false" })));
      expect(poolInstances[0]?.options.ssl).toBe(false);
    });

    it("空入力: DATABASE_SSL・DATABASE_PORT・DATABASE_NAME が未設定なら、SSL なし・5432・admin_auth にする", () => {
      createPool(loadConfig(validEnv()));
      expect(poolInstances[0]?.options).toMatchObject({ ssl: false, port: 5432, database: "admin_auth" });
    });
  });

  describe("異常系", () => {
    it("サーバ: アイドル接続のエラーはメッセージだけを記録して、例外にしない", () => {
      const stderr = captureStderr();
      createPool(loadConfig(validEnv()));
      const handler = poolInstances[0]?.handlers.get("error");
      expect(handler).toBeTypeOf("function");
      expect(() => handler!(new Error("terminating connection"))).not.toThrow();
      expect(stderr.text()).toBe("[db] terminating connection");
    });

    it("サーバ: アイドル接続のエラーを記録するときに、接続の設定（パスワード）を出さない", () => {
      const stderr = captureStderr();
      createPool(loadConfig(validEnv()));
      poolInstances[0]?.handlers.get("error")!(new Error("Connection terminated unexpectedly"));
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });
});
