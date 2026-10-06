import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

describe("openAuthDatabase", () => {
  it("E-15 とは別のファイルを 0600 で作り、E-15 のテーブルは作らない", () => {
    const db = track(openAuthDatabase(temp.dir));
    const file = join(temp.dir, AUTH_DB_FILENAME);
    expect(AUTH_DB_FILENAME).not.toBe(E15_DB_FILENAME);
    expect(mode(file)).toBe(0o600);
    expect(mode(temp.dir)).toBe(0o700);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    expect(existsSync(join(temp.dir, E15_DB_FILENAME))).toBe(false);
  });
});

describe("transaction", () => {
  function kvDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    return db;
  }

  it("成功すれば COMMIT して戻り値を返す", () => {
    const db = kvDb();
    const result = transaction(db, () => {
      db.prepare("INSERT INTO t VALUES ('a')").run();
      return 42;
    });
    expect(result).toBe(42);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
  });

  it("例外なら ROLLBACK して同じ例外を投げ直す", () => {
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
});
