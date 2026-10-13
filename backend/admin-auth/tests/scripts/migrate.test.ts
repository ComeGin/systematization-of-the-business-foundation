import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureStderr, DB_PASSWORD, mockExit, SECRET, stubValidEnv } from "../helpers/env.js";

// better-auth/db/migration・allowlist・auth・db はすべて偽物に差し替える（実 DB には繋がない）。
// 呼ばれた順序は mocks.order に積み、テストごとに beforeEach で空にする
const mocks = vi.hoisted(() => ({
  order: [] as string[],
  getMigrations: vi.fn(),
  runMigrations: vi.fn(),
  ensureAllowlistTable: vi.fn(),
  bootstrapAllowlist: vi.fn(),
  createAuthOptions: vi.fn((..._args: unknown[]) => ({ options: true })),
  pool: { end: vi.fn() },
}));
vi.mock("better-auth/db/migration", () => ({ getMigrations: mocks.getMigrations }));
vi.mock("../../src/allowlist.js", () => ({ ensureAllowlistTable: mocks.ensureAllowlistTable, bootstrapAllowlist: mocks.bootstrapAllowlist }));
vi.mock("../../src/auth.js", () => ({ createAuthOptions: mocks.createAuthOptions }));
vi.mock("../../src/db.js", () => ({ createPool: () => mocks.pool }));

let stderr: ReturnType<typeof captureStderr>;

async function run() {
  vi.resetModules();
  await import("../../src/scripts/migrate.js");
}

beforeEach(() => {
  stubValidEnv({ ADMIN_BOOTSTRAP_EMAILS: "a@comegin.com" });
  stderr = captureStderr();
  mocks.order.length = 0;
  mocks.runMigrations.mockReset().mockImplementation(async () => void mocks.order.push("runMigrations"));
  mocks.ensureAllowlistTable.mockReset().mockImplementation(async () => void mocks.order.push("ensureAllowlistTable"));
  mocks.bootstrapAllowlist.mockReset().mockImplementation(async () => {
    mocks.order.push("bootstrapAllowlist");
    return 1;
  });
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
  describe("正常系", () => {
    it("Better Auth のスキーマを移行してから許可リストの表を作り、最後に接続を閉じる", async () => {
      await run();
      expect(mocks.order).toEqual(["runMigrations", "ensureAllowlistTable", "bootstrapAllowlist", "end"]);
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

    it("空入力: 差分が 0 件（適用済み）でも、移行と許可リストの表の作成を呼び（冪等）、両方 - と出す", async () => {
      mocks.getMigrations.mockResolvedValue({ toBeCreated: [], toBeAdded: [], runMigrations: mocks.runMigrations });
      await run();
      expect(stderr.text()).toContain("create tables: - / add columns: -");
      expect(mocks.order).toEqual(["runMigrations", "ensureAllowlistTable", "bootstrapAllowlist", "end"]);
      expect(process.exitCode).toBeUndefined();
    });

    it("最後に許可リストの初期値を追加し、件数を出す（起動時から移した。仕様 3.5）", async () => {
      await run();
      expect(mocks.bootstrapAllowlist).toHaveBeenCalledWith(mocks.pool, ["a@comegin.com"]);
      expect(stderr.text()).toContain("[migrate] allowlist bootstrap: 1 added");
    });

    it("ログにシークレットと DB のパスワードを出さない", async () => {
      await run();
      expect(stderr.text()).not.toContain(SECRET);
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });
  });

  describe("異常系", () => {
    it("サーバ: 移行に失敗したら許可リストの表を作らず、exitCode=1 にして接続は閉じる", async () => {
      mocks.runMigrations.mockRejectedValue(new Error("permission denied"));
      await run();
      expect(mocks.ensureAllowlistTable).not.toHaveBeenCalled();
      expect(stderr.text()).toContain("[migrate] failed: permission denied");
      expect(process.exitCode).toBe(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 許可リストの表の作成に失敗しても exitCode=1 にする", async () => {
      mocks.ensureAllowlistTable.mockRejectedValue(new Error("syntax error"));
      await run();
      expect(process.exitCode).toBe(1);
      expect(stderr.text()).not.toContain("[migrate] done");
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 差分を求める段階（DB への接続）で失敗しても、exitCode=1 にして接続は閉じる", async () => {
      mocks.getMigrations.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
      await run();
      expect(mocks.runMigrations).not.toHaveBeenCalled();
      expect(stderr.text()).toContain("[migrate] failed: connect ECONNREFUSED");
      expect(stderr.text()).not.toContain(DB_PASSWORD);
      expect(process.exitCode).toBe(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 初期値の追加に失敗しても exitCode=1 にし、done を出さない", async () => {
      mocks.bootstrapAllowlist.mockRejectedValue(new Error("check constraint"));
      await run();
      expect(process.exitCode).toBe(1);
      expect(stderr.text()).not.toContain("[migrate] done");
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    });

    it("入力: 設定が不正なら、DB に触れずに終了する", async () => {
      vi.stubEnv("BETTER_AUTH_SECRET", "short");
      mockExit();
      await expect(run()).rejects.toThrow("process.exit(1)");
      expect(mocks.getMigrations).not.toHaveBeenCalled();
      expect(stderr.text()).not.toContain(DB_PASSWORD);
    });

    it("空入力: DATABASE_HOST が空なら、DB に触れずに終了する", async () => {
      vi.stubEnv("DATABASE_HOST", "");
      mockExit();
      await expect(run()).rejects.toThrow("process.exit(1)");
      expect(mocks.getMigrations).not.toHaveBeenCalled();
    });
  });
});
