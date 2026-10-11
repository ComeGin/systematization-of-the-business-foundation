import { describe, expect, it } from "vitest";
import { bootstrapAllowlist, ensureAllowlistTable, findUserEmail, isAllowlisted } from "../src/allowlist.js";
import { DB_PASSWORD } from "./helpers/env.js";
import { fakePool } from "./helpers/pool.js";

// pg.Pool は helpers/pool.ts の偽物に差し替える（実 DB には繋がない）

/** query が RDS 側の例外で失敗する pg.Pool の代わり */
function failingPool(message: string) {
  return fakePool(() => {
    throw new Error(message);
  });
}

describe("ensureAllowlistTable", () => {
  describe("正常系", () => {
    it("小文字以外のメールを拒否する CHECK 制約つきで、既存の表を壊さずに作る", async () => {
      const { pool, query } = fakePool();
      await ensureAllowlistTable(pool);
      const sql = String(query.mock.calls[0]?.[0]);
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS admin_allowlist/);
      expect(sql).toMatch(/CHECK \(email = lower\(email\)\)/);
    });

    it("空入力: 応答が 0 件（rowCount が null）でも例外にしない", async () => {
      const { pool } = fakePool(() => ({ rowCount: null, rows: [] }));
      await expect(ensureAllowlistTable(pool)).resolves.toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("サーバ: DB の例外（権限なしなど）は握りつぶさず、そのまま投げる", async () => {
      const { pool } = failingPool("permission denied for schema public");
      await expect(ensureAllowlistTable(pool)).rejects.toThrow("permission denied for schema public");
    });
  });
});

describe("bootstrapAllowlist", () => {
  describe("正常系", () => {
    it("空入力: 空配列のときは DB に問い合わせず 0 を返す", async () => {
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

    it("空入力: rowCount が null（0 件の応答）でも 0 を返す", async () => {
      const { pool } = fakePool(() => ({ rowCount: null }));
      await expect(bootstrapAllowlist(pool, ["a@comegin.com"])).resolves.toBe(0);
    });
  });

  describe("異常系", () => {
    it("サーバ: 表が無い（db:migrate 前）ときの DB の例外は、そのまま投げる（起動側が exit(1) にする）", async () => {
      const { pool } = failingPool('relation "admin_allowlist" does not exist');
      await expect(bootstrapAllowlist(pool, ["a@comegin.com"])).rejects.toThrow('relation "admin_allowlist" does not exist');
    });

    it("サーバ: 接続に失敗した例外のメッセージに、DB のパスワードを足さない", async () => {
      const { pool } = failingPool("connect ECONNREFUSED");
      const error = (await bootstrapAllowlist(pool, ["a@comegin.com"]).then(
        () => new Error("失敗しなかった"),
        (e: unknown) => e,
      )) as Error;
      expect(error.message).toBe("connect ECONNREFUSED");
      expect(error.message).not.toContain(DB_PASSWORD);
    });
  });
});

describe("isAllowlisted", () => {
  describe("正常系", () => {
    it("大文字を含むメールも小文字にして照合する", async () => {
      const { pool, query } = fakePool(() => ({ rowCount: 1 }));
      await expect(isAllowlisted(pool, "Person@COMEGIN.com")).resolves.toBe(true);
      expect(query.mock.calls[0]?.[1]).toEqual(["person@comegin.com"]);
    });

    it("空入力: 行が無ければ（0 件の応答）false を返す", async () => {
      const { pool } = fakePool(() => ({ rowCount: 0 }));
      await expect(isAllowlisted(pool, "x@comegin.com")).resolves.toBe(false);
    });

    it("空入力: rowCount が null なら false を返す", async () => {
      const { pool } = fakePool(() => ({ rowCount: null }));
      await expect(isAllowlisted(pool, "x@comegin.com")).resolves.toBe(false);
    });

    it("空入力: 空文字のメールは、空文字のまま照合して（一致する行は無い）false を返す", async () => {
      const { pool, query } = fakePool(() => ({ rowCount: 0 }));
      await expect(isAllowlisted(pool, "")).resolves.toBe(false);
      expect(query.mock.calls[0]?.[1]).toEqual([""]);
    });
  });

  describe("異常系", () => {
    it("入力: メールを SQL の文字列に埋め込まない", async () => {
      const { pool, query } = fakePool();
      await isAllowlisted(pool, "x'; DROP TABLE admin_allowlist; --@comegin.com");
      expect(String(query.mock.calls[0]?.[0])).not.toContain("DROP");
    });

    it("サーバ: DB の例外は握りつぶさず（許可とみなさず）、そのまま投げる", async () => {
      const { pool } = failingPool("Connection terminated unexpectedly");
      await expect(isAllowlisted(pool, "x@comegin.com")).rejects.toThrow("Connection terminated unexpectedly");
    });
  });
});

describe("findUserEmail", () => {
  describe("正常系", () => {
    it("Better Auth の user 表からメールを引く", async () => {
      const { pool, query } = fakePool(() => ({ rows: [{ email: "a@comegin.com" }] }));
      await expect(findUserEmail(pool, "user-1")).resolves.toBe("a@comegin.com");
      expect(String(query.mock.calls[0]?.[0])).toContain(`FROM "user"`);
      expect(query.mock.calls[0]?.[1]).toEqual(["user-1"]);
    });

    it("空入力: ユーザーが無ければ（0 件の応答）null を返す", async () => {
      const { pool } = fakePool(() => ({ rows: [] }));
      await expect(findUserEmail(pool, "missing")).resolves.toBeNull();
    });

    it("空入力: 空文字の userId もパラメーターで渡し、行が無ければ null を返す", async () => {
      const { pool, query } = fakePool(() => ({ rows: [] }));
      await expect(findUserEmail(pool, "")).resolves.toBeNull();
      expect(query.mock.calls[0]?.[1]).toEqual([""]);
    });
  });

  describe("異常系", () => {
    it("入力: userId を SQL の文字列に埋め込まない", async () => {
      const { pool, query } = fakePool(() => ({ rows: [] }));
      await findUserEmail(pool, `u1' OR '1'='1`);
      expect(String(query.mock.calls[0]?.[0])).not.toContain("OR '1'='1");
    });

    it("サーバ: 想定外の形の応答（email の無い行）は null を返す", async () => {
      const { pool } = fakePool(() => ({ rows: [{}] }));
      await expect(findUserEmail(pool, "user-1")).resolves.toBeNull();
    });

    it("サーバ: DB の例外は、そのまま投げる", async () => {
      const { pool } = failingPool("canceling statement due to statement timeout");
      await expect(findUserEmail(pool, "user-1")).rejects.toThrow("canceling statement due to statement timeout");
    });
  });
});
