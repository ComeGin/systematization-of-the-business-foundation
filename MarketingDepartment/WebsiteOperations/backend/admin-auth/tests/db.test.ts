import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { captureStderr, validEnv } from "./helpers/env.js";

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
    createPool(loadConfig(validEnv()));
    expect(poolInstances[0]?.options.ssl).toBe(false);
  });

  it("アイドル接続のエラーはメッセージだけを記録して、例外にしない", () => {
    const stderr = captureStderr();
    createPool(loadConfig(validEnv()));
    const handler = poolInstances[0]?.handlers.get("error");
    expect(handler).toBeTypeOf("function");
    expect(() => handler!(new Error("terminating connection"))).not.toThrow();
    expect(stderr.text()).toBe("[db] terminating connection");
  });
});
