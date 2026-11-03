// --check（ctx.checkOnly）の読むだけの保証の単体テスト: ctx.writeEnvFile が書かずに例外を投げること、
// cloud/setup/aws.mjs の dbInitDone が --check では状態に書かないこと。
// HOME は一時ディレクトリ（tests/helpers/temp-home.mjs）。AWS は ctx.run の偽物で代用する。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCoreWithTempHome, removeTempDir } from "../helpers/temp-home.mjs";

let home;
let core;
beforeEach(async () => {
  ({ home, core } = await importCoreWithTempHome());
});
afterEach(() => {
  removeTempDir(home);
  vi.unstubAllEnvs();
});

const makeCtx = (checkOnly) => core.createContext({ target: "prod", conf: {}, state: new core.State("prod", { readOnly: checkOnly }), moduleId: "t", phase: "apps", checkOnly });

describe("check の ctx.writeEnvFile", () => {
  describe("正常系", () => {
    it("入力: checkOnly でなければ今までどおり環境変数ファイルを書く", () => {
      const ctx = makeCtx(false);
      const path = join(home, "work/.env.test");
      const changed = ctx.writeEnvFile(path, { A: "1" });
      expect(changed).toEqual(["A"]);
      expect(readFileSync(path, "utf8")).toContain("A=1");
    });

    it("入力: checkOnly でも readEnvFile（読む）は使える", () => {
      const ctx = makeCtx(true);
      expect(ctx.readEnvFile(join(home, "nothing/.env.test"))).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: checkOnly なら書かずに「check の中で環境変数ファイルを書こうとした: <パス>」を投げる", () => {
      const ctx = makeCtx(true);
      const path = join(home, "work/.env.checkonly-test"); // リポジトリの中には置かない（ガードが無いと実際に書かれてしまうため）
      expect(() => ctx.writeEnvFile(path, { A: "secret-value-0123" })).toThrow(/^check の中で環境変数ファイルを書こうとした: .*\.env\.checkonly-test$/);
      expect(existsSync(path)).toBe(false);
    });

    it("入力: 例外の文に値は出ない", () => {
      const ctx = makeCtx(true);
      try {
        ctx.writeEnvFile(join(home, "x/.env.test"), { TOKEN: "secret-value-0123" });
      } catch (e) {
        expect(e.message).not.toContain("secret-value-0123");
      }
      expect.assertions(1);
    });
  });
});

describe("dbInitDone（cloud/setup/aws.mjs）", () => {
  const events = JSON.stringify({ events: [{ message: "db-init-postgres: done" }] });
  const main = { CreationTime: "2026-10-30T00:00:00Z" };

  function awsCtx(checkOnly) {
    const sets = [];
    const ctx = {
      checkOnly,
      state: {
        get: () => undefined,
        set: (key, value) => {
          if (checkOnly) throw new Error(`check の中で状態を書こうとした: ${key}`);
          sets.push([key, value]);
        },
      },
      run: async () => events,
    };
    return { ctx, sets };
  }

  describe("正常系", () => {
    it("入力: --check（checkOnly）で opts を渡さなくても、成功を見つけて true を返し、状態には書かない", async () => {
      const { dbInitDone } = await import("../../../cloud/setup/aws.mjs");
      const { ctx, sets } = awsCtx(true);
      await expect(dbInitDone(ctx, main, "postgres")).resolves.toBe(true);
      expect(sets).toEqual([]);
    });

    it("入力: apply（checkOnly でない）は今までどおり、成功を状態に残す", async () => {
      const { dbInitDone } = await import("../../../cloud/setup/aws.mjs");
      const { ctx, sets } = awsCtx(false);
      await expect(dbInitDone(ctx, main, "postgres")).resolves.toBe(true);
      expect(sets).toEqual([["DB_INIT_POSTGRES_STACK_CREATED", main.CreationTime]]);
    });

    it("入力: record: false を明示すれば apply でも書かない", async () => {
      const { dbInitDone } = await import("../../../cloud/setup/aws.mjs");
      const { ctx, sets } = awsCtx(false);
      await dbInitDone(ctx, main, "postgres", { record: false });
      expect(sets).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 成功のログが無いと false を返し、--check でも例外にならない", async () => {
      const { dbInitDone } = await import("../../../cloud/setup/aws.mjs");
      const { ctx } = awsCtx(true);
      ctx.run = async () => JSON.stringify({ events: [] });
      await expect(dbInitDone(ctx, main, "mysql")).resolves.toBe(false);
    });
  });
});
