import { describe, expect, it } from "vitest";
import { bootstrapAllowlist, ensureAllowlistTable, findUserEmail, isAllowlisted } from "../src/allowlist.js";
import { fakePool } from "./helpers/pool.js";

describe("ensureAllowlistTable", () => {
  it("小文字以外のメールを拒否する CHECK 制約つきで、既存の表を壊さずに作る", async () => {
    const { pool, query } = fakePool();
    await ensureAllowlistTable(pool);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS admin_allowlist/);
    expect(sql).toMatch(/CHECK \(email = lower\(email\)\)/);
  });
});

describe("bootstrapAllowlist", () => {
  it("空のときは DB に問い合わせず 0 を返す", async () => {
    const { pool, query } = fakePool();
    await expect(bootstrapAllowlist(pool, [])).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("メールを小文字にしてパラメーターで渡し、既存の行には触れない（ON CONFLICT DO NOTHING）", async () => {
    const { pool, query } = fakePool(() => ({ rowCount: 2 }));
    await expect(bootstrapAllowlist(pool, ["Alice@Comegin.com", "bob@comegin.com"])).resolves.toBe(2);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/ON CONFLICT \(email\) DO NOTHING/);
    expect(sql).not.toContain("alice");
    expect(params).toEqual([["alice@comegin.com", "bob@comegin.com"]]);
  });

  it("追加の印として added_by に bootstrap を入れる", async () => {
    const { pool, query } = fakePool(() => ({ rowCount: 1 }));
    await bootstrapAllowlist(pool, ["a@comegin.com"]);
    expect(String(query.mock.calls[0]?.[0])).toContain("'bootstrap'");
  });

  it("rowCount が null でも 0 を返す", async () => {
    const { pool } = fakePool(() => ({ rowCount: null }));
    await expect(bootstrapAllowlist(pool, ["a@comegin.com"])).resolves.toBe(0);
  });
});

describe("isAllowlisted", () => {
  it("大文字を含むメールも小文字にして照合する", async () => {
    const { pool, query } = fakePool(() => ({ rowCount: 1 }));
    await expect(isAllowlisted(pool, "Person@COMEGIN.com")).resolves.toBe(true);
    expect(query.mock.calls[0]?.[1]).toEqual(["person@comegin.com"]);
  });

  it("行が無ければ false を返す", async () => {
    const { pool } = fakePool(() => ({ rowCount: 0 }));
    await expect(isAllowlisted(pool, "x@comegin.com")).resolves.toBe(false);
  });

  it("rowCount が null なら false を返す", async () => {
    const { pool } = fakePool(() => ({ rowCount: null }));
    await expect(isAllowlisted(pool, "x@comegin.com")).resolves.toBe(false);
  });

  it("メールを SQL の文字列に埋め込まない", async () => {
    const { pool, query } = fakePool();
    await isAllowlisted(pool, "x'; DROP TABLE admin_allowlist; --@comegin.com");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("DROP");
  });
});

describe("findUserEmail", () => {
  it("Better Auth の user 表からメールを引く", async () => {
    const { pool, query } = fakePool(() => ({ rows: [{ email: "a@comegin.com" }] }));
    await expect(findUserEmail(pool, "user-1")).resolves.toBe("a@comegin.com");
    expect(String(query.mock.calls[0]?.[0])).toContain(`FROM "user"`);
    expect(query.mock.calls[0]?.[1]).toEqual(["user-1"]);
  });

  it("ユーザーが無ければ null を返す", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    await expect(findUserEmail(pool, "missing")).resolves.toBeNull();
  });
});
