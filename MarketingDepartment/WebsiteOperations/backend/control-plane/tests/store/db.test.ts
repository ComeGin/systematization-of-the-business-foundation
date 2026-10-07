// 基準 D の例外: テスト対象そのものが SQLite のファイル操作（権限・WAL・マイグレーション）のため、
// node:sqlite は差し替えず、os.tmpdir() の下の一時ディレクトリと :memory: の実 SQLite で確かめる（外部のサーバーには繋がない）。
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_DB_FILENAME,
  E15_DB_FILENAME,
  openAuthDatabase,
  openE15Database,
  transaction,
} from "../../src/store/db.js";
import { makeTempDir } from "../helpers/store.js";

const mode = (path: string) => statSync(path).mode & 0o777;

let temp: ReturnType<typeof makeTempDir>;
const opened: DatabaseSync[] = [];

beforeEach(() => {
  temp = makeTempDir();
});

afterEach(() => {
  for (const db of opened.splice(0)) if (db.isOpen) db.close();
  temp.cleanup();
});

function track(db: DatabaseSync): DatabaseSync {
  opened.push(db);
  return db;
}

describe("openE15Database", () => {
  describe("正常系", () => {
    it("無いディレクトリを途中まで作り、ディレクトリは 0700・ファイルは 0600 にする", () => {
      const dataDir = join(temp.dir, "a", "b");
      track(openE15Database(dataDir));
      expect(mode(dataDir)).toBe(0o700);
      expect(mode(join(dataDir, E15_DB_FILENAME))).toBe(0o600);
    });

    it("既にあるディレクトリが緩い権限でも 0700 に締め直す", () => {
      const dataDir = join(temp.dir, "loose");
      mkdirSync(dataDir, { mode: 0o755 });
      chmodSync(dataDir, 0o755);
      track(openE15Database(dataDir));
      expect(mode(dataDir)).toBe(0o700);
    });

    it("WAL にし、マイグレーション済みで返す", () => {
      const db = track(openE15Database(temp.dir));
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runs'").get()).toEqual({ name: "runs" });
    });

    it("書き込み後にできる -wal ファイルも他人から読めない", () => {
      const db = track(openE15Database(temp.dir));
      db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('k', 'v', 't')").run();
      const wal = join(temp.dir, `${E15_DB_FILENAME}-wal`);
      expect(existsSync(wal)).toBe(true);
      expect(mode(wal) & 0o077).toBe(0);
    });

    it("開き直してもデータが残る（マイグレーションは冪等）", () => {
      const first = track(openE15Database(temp.dir));
      first.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('k', 'v', 't')").run();
      first.close();
      const second = track(openE15Database(temp.dir));
      expect(second.prepare("SELECT value FROM kv WHERE key = 'k'").get()).toEqual({ value: "v" });
    });

    it("空入力: 空のディレクトリに開くと、E-15 のテーブルが空の状態で使える", () => {
      const db = track(openE15Database(join(temp.dir, "empty")));
      expect(db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
    });
  });

  describe("異常系", () => {
    it("空入力: dataDir が空文字なら例外を投げる（カレントディレクトリに作らない）", () => {
      expect(() => openE15Database("")).toThrow();
      expect(existsSync(E15_DB_FILENAME)).toBe(false);
    });

    it("サーバ: dataDir の途中がファイルでディレクトリを作れなければ例外を投げる", () => {
      writeFileSync(join(temp.dir, "file"), "x");
      expect(() => openE15Database(join(temp.dir, "file", "data"))).toThrow(/ENOTDIR|EEXIST/);
    });

    it("サーバ: コードより新しい版の E-15 は開いた後のマイグレーションで例外にする", () => {
      const db = track(openE15Database(temp.dir));
      db.exec("PRAGMA user_version = 999");
      db.close();
      expect(() => track(openE15Database(temp.dir))).toThrow(/（999）/);
    });
  });
});

describe("openAuthDatabase", () => {
  describe("正常系", () => {
    it("空入力: E-15 とは別の空のファイルを 0600 で作り、E-15 のテーブルは作らない", () => {
      const db = track(openAuthDatabase(temp.dir));
      const file = join(temp.dir, AUTH_DB_FILENAME);
      expect(AUTH_DB_FILENAME).not.toBe(E15_DB_FILENAME);
      expect(mode(file)).toBe(0o600);
      expect(mode(temp.dir)).toBe(0o700);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
      expect(existsSync(join(temp.dir, E15_DB_FILENAME))).toBe(false);
    });

    it("WAL にして返す", () => {
      const db = track(openAuthDatabase(temp.dir));
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    });
  });

  describe("異常系", () => {
    it("サーバ: dataDir の途中がファイルでディレクトリを作れなければ例外を投げる", () => {
      writeFileSync(join(temp.dir, "file"), "x");
      expect(() => openAuthDatabase(join(temp.dir, "file", "auth"))).toThrow(/ENOTDIR|EEXIST/);
    });
  });
});

describe("transaction", () => {
  function kvDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    return db;
  }

  describe("正常系", () => {
    it("成功すれば COMMIT して戻り値を返す", () => {
      const db = kvDb();
      const result = transaction(db, () => {
        db.prepare("INSERT INTO t VALUES ('a')").run();
        return 42;
      });
      expect(result).toBe(42);
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
    });

    it("空入力: 何もしない関数でも COMMIT して undefined を返す", () => {
      const db = kvDb();
      expect(transaction(db, () => undefined)).toBeUndefined();
      expect(db.isTransaction).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 関数が例外なら ROLLBACK して同じ例外を投げ直す", () => {
      const db = kvDb();
      const boom = new Error("boom");
      expect(() =>
        transaction(db, () => {
          db.prepare("INSERT INTO t VALUES ('a')").run();
          throw boom;
        }),
      ).toThrow(boom);
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
      expect(db.isTransaction).toBe(false);
    });

    it("サーバ: BEGIN IMMEDIATE が取れなければ（別の接続が書き込み中）関数を呼ばずに例外を投げる", () => {
      const file = join(temp.dir, "busy.sqlite");
      const holder = track(new DatabaseSync(file));
      holder.exec("CREATE TABLE t (v TEXT)");
      const other = track(new DatabaseSync(file));
      other.exec("PRAGMA busy_timeout = 0");
      holder.exec("BEGIN IMMEDIATE");
      const fn = vi.fn(() => 1);
      expect(() => transaction(other, fn)).toThrow(/locked|busy/i);
      expect(fn).not.toHaveBeenCalled();
      holder.exec("ROLLBACK");
    });
  });
});
