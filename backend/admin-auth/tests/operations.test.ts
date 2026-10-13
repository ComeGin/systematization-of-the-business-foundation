import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAlbClient, runMigrate } from "../src/operations.js";
import { fakePool } from "./helpers/pool.js";

const mocks = vi.hoisted(() => ({ order: [] as string[], getMigrations: vi.fn(), runMigrations: vi.fn() }));
vi.mock("better-auth/db/migration", () => ({ getMigrations: mocks.getMigrations }));

const ALB = {
  ALB_CLIENT_ID: "alb-admin-gate",
  ALB_CLIENT_SECRET: "alb-secret-0123456789abcdefghijklmnopq",
  ALB_PROTECTED_HOSTS: ["chat.comegin.com", "mkt.comegin.com"],
};

beforeEach(() => {
  mocks.order.length = 0;
  mocks.runMigrations.mockReset().mockImplementation(async () => void mocks.order.push("runMigrations"));
  mocks.getMigrations.mockReset().mockResolvedValue({ toBeCreated: [{ table: "user" }], toBeAdded: [], runMigrations: mocks.runMigrations });
});

describe("runMigrate", () => {
  describe("正常系", () => {
    it("移行 → 許可リストの表の作成 → 初期値の追加の順に行い、結果を返す", async () => {
      const { pool, query } = fakePool((sql) => {
        mocks.order.push(sql.includes("CREATE TABLE") ? "ensure" : "bootstrap");
        return { rowCount: sql.includes("INSERT") ? 2 : 0 };
      });
      const lines: string[] = [];
      const result = await runMigrate(pool, { options: true } as never, ["a@comegin.com", "B@comegin.com"], (line) => lines.push(line));
      expect(mocks.order).toEqual(["runMigrations", "ensure", "bootstrap"]);
      expect(result).toEqual({ createdTables: ["user"], addedColumnsTables: [], bootstrapped: 2 });
      expect(query.mock.calls[1]?.[1]).toEqual([["a@comegin.com", "b@comegin.com"]]);
      expect(lines).toEqual(["[migrate] create tables: user / add columns: -", "[migrate] allowlist bootstrap: 2 added"]);
    });

    it("空入力: 初期値が空なら追加の SQL を発行せず、0 件と出す", async () => {
      const { pool, query } = fakePool();
      const lines: string[] = [];
      const result = await runMigrate(pool, {} as never, [], (line) => lines.push(line));
      expect(result.bootstrapped).toBe(0);
      expect(query).toHaveBeenCalledTimes(1);
      expect(lines.at(-1)).toBe("[migrate] allowlist bootstrap: 0 added");
    });
  });

  describe("異常系", () => {
    it("サーバ: 移行に失敗したら、表も初期値も触らずに投げる", async () => {
      mocks.runMigrations.mockRejectedValue(new Error("permission denied"));
      const { pool, query } = fakePool();
      await expect(runMigrate(pool, {} as never, ["a@comegin.com"], () => {})).rejects.toThrow("permission denied");
      expect(query).not.toHaveBeenCalled();
    });
  });
});

describe("registerAlbClient", () => {
  const adapter = { findOne: vi.fn(), update: vi.fn(), create: vi.fn() };
  const auth = { $context: Promise.resolve({ adapter }) } as never;
  const options = { authMethod: "client_secret_basic" as const, requirePkce: false };

  beforeEach(() => {
    adapter.findOne.mockReset().mockResolvedValue(null);
    adapter.update.mockReset().mockResolvedValue(undefined);
    adapter.create.mockReset().mockResolvedValue(undefined);
  });

  describe("正常系", () => {
    it("無ければ作り（created）、リダイレクト URI を返す。シークレットは SHA-256 の base64url で保存する", async () => {
      const result = await registerAlbClient(auth, ALB, options);
      expect(result).toEqual({
        outcome: "created",
        redirectUris: ["https://chat.comegin.com/oauth2/idpresponse", "https://mkt.comegin.com/oauth2/idpresponse"],
      });
      const data = adapter.create.mock.calls[0]![0].data as Record<string, unknown>;
      expect(data.clientSecret).toBe(createHash("sha256").update(ALB.ALB_CLIENT_SECRET).digest("base64url"));
      expect(data).toMatchObject({ clientId: ALB.ALB_CLIENT_ID, tokenEndpointAuthMethod: "client_secret_basic", requirePKCE: false, skipConsent: true });
    });

    it("同じ内容なら何も書かずに unchanged", async () => {
      await registerAlbClient(auth, ALB, options);
      const stored = { ...(adapter.create.mock.calls[0]![0].data as Record<string, unknown>) };
      adapter.findOne.mockResolvedValue(stored);
      adapter.create.mockClear();
      expect((await registerAlbClient(auth, ALB, options)).outcome).toBe("unchanged");
      expect(adapter.update).not.toHaveBeenCalled();
      expect(adapter.create).not.toHaveBeenCalled();
    });

    it("認証方式が変われば updated", async () => {
      await registerAlbClient(auth, ALB, options);
      adapter.findOne.mockResolvedValue({ ...(adapter.create.mock.calls[0]![0].data as Record<string, unknown>) });
      const result = await registerAlbClient(auth, ALB, { authMethod: "client_secret_post", requirePkce: true });
      expect(result.outcome).toBe("updated");
      expect(adapter.update.mock.calls[0]![0].update).toMatchObject({ tokenEndpointAuthMethod: "client_secret_post", requirePKCE: true });
    });
  });

  describe("異常系", () => {
    it("サーバ: 行の作成に失敗したら投げる", async () => {
      adapter.create.mockRejectedValue(new Error("unique violation"));
      await expect(registerAlbClient(auth, ALB, options)).rejects.toThrow("unique violation");
    });

    it("空入力: 保護するホストが 0 件でも、リダイレクト URI は空のまま登録する（検証は設定の側で行う）", async () => {
      const result = await registerAlbClient(auth, { ...ALB, ALB_PROTECTED_HOSTS: [] }, options);
      expect(result.redirectUris).toEqual([]);
    });
  });
});
