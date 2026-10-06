import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStderr, mockExit, stubValidEnv } from "../helpers/env.js";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  getMigrations: vi.fn(),
  runMigrations: vi.fn(),
  ensureAllowlistTable: vi.fn(),
  createAuthOptions: vi.fn((..._args: unknown[]) => ({ options: true })),
  pool: { end: vi.fn() },
}));
vi.mock("better-auth/db/migration", () => ({ getMigrations: mocks.getMigrations }));
vi.mock("../../src/allowlist.js", () => ({ ensureAllowlistTable: mocks.ensureAllowlistTable }));
vi.mock("../../src/auth.js", () => ({ createAuthOptions: mocks.createAuthOptions }));
vi.mock("../../src/db.js", () => ({ createPool: () => mocks.pool }));

let stderr: ReturnType<typeof captureStderr>;

async function run() {
  vi.resetModules();
  await import("../../src/scripts/migrate.js");
}

beforeEach(() => {
  stubValidEnv();
  stderr = captureStderr();
  mocks.order.length = 0;
  mocks.runMigrations.mockReset().mockImplementation(async () => void mocks.order.push("runMigrations"));
  mocks.ensureAllowlistTable.mockReset().mockImplementation(async () => void mocks.order.push("ensureAllowlistTable"));
  mocks.getMigrations.mockReset().mockResolvedValue({
    toBeCreated: [{ table: "user" }, { table: "session" }],
    toBeAdded: [],
    runMigrations: mocks.runMigrations,
  });
  mocks.pool.end.mockReset().mockImplementation(async () => void mocks.order.push("end"));
  mocks.createAuthOptions.mockClear();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("migrate", () => {
  it("Better Auth のスキーマを移行してから許可リストの表を作り、最後に接続を閉じる", async () => {
    await run();
    expect(mocks.order).toEqual(["runMigrations", "ensureAllowlistTable", "end"]);
    expect(mocks.ensureAllowlistTable).toHaveBeenCalledWith(mocks.pool);
    expect(process.exitCode).toBeUndefined();
  });

  it("本体と同じ設定（createAuthOptions）でスキーマの差分を求める", async () => {
    await run();
    expect(mocks.createAuthOptions.mock.calls[0]?.[1]).toBe(mocks.pool);
    expect(mocks.getMigrations).toHaveBeenCalledWith({ options: true });
  });

  it("作る表と列を足す表を一覧で出す（無ければ -）", async () => {
    await run();
    expect(stderr.text()).toContain("create tables: user, session / add columns: -");
    expect(stderr.text()).toContain("[migrate] done");
  });

  it("移行に失敗したら許可リストの表を作らず、exitCode=1 にして接続は閉じる", async () => {
    mocks.runMigrations.mockRejectedValue(new Error("permission denied"));
    await run();
    expect(mocks.ensureAllowlistTable).not.toHaveBeenCalled();
    expect(stderr.text()).toContain("[migrate] failed: permission denied");
    expect(process.exitCode).toBe(1);
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("許可リストの表の作成に失敗しても exitCode=1 にする", async () => {
    mocks.ensureAllowlistTable.mockRejectedValue(new Error("syntax error"));
    await run();
    expect(process.exitCode).toBe(1);
    expect(stderr.text()).not.toContain("[migrate] done");
  });

  it("設定が不正なら、DB に触れずに終了する", async () => {
    vi.stubEnv("DATABASE_HOST", "");
    mockExit();
    await expect(run()).rejects.toThrow("process.exit(1)");
    expect(mocks.getMigrations).not.toHaveBeenCalled();
  });
});
