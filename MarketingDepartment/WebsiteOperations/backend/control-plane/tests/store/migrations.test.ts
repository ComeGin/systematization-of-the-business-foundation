import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/store/migrations.js";

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tables(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
  ).map((row) => row.name);
}

describe("migrate", () => {
  it("空の DB に 4 つのテーブルを作り、user_version を進める", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(tables(db)).toEqual(["kv", "leases", "miswrite_candidates", "runs"]);
    expect(userVersion(db)).toBeGreaterThanOrEqual(1);
  });

  it("2 回目以降は何もしない（冪等）。データも残る", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const version = userVersion(db);
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('k', 'v', 't')").run();
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    expect(userVersion(db)).toBe(version);
    expect(db.prepare("SELECT value FROM kv WHERE key = 'k'").get()).toEqual({ value: "v" });
  });

  it("コードより新しい版の DB は開かずに例外にする（版番号を含める）", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const newer = userVersion(db) + 1;
    db.exec(`PRAGMA user_version = ${newer}`);
    expect(() => migrate(db)).toThrow(new RegExp(`（${newer}）`));
  });

  it("途中で失敗した版は ROLLBACK され、作りかけのテーブルも user_version も残らない", () => {
    const db = new DatabaseSync(":memory:");
    // 版 1 の途中（kv の CREATE）で衝突させる
    db.exec("CREATE TABLE kv (x INTEGER)");
    expect(() => migrate(db)).toThrow();
    expect(userVersion(db)).toBe(0);
    expect(tables(db)).toEqual(["kv"]);
    // 失敗のあともトランザクションは残っていない（次の BEGIN が通る）
    expect(() => db.exec("BEGIN IMMEDIATE; ROLLBACK;")).not.toThrow();
  });

  it("CHECK 制約で trigger_kind・status・outcome の値を縛る", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const insert = (trigger: string, status: string, outcome: string | null) =>
      db
        .prepare(
          "INSERT INTO runs (run_id, trigger_kind, status, started_at, outcome) VALUES (?, ?, ?, '2026-10-05T00:00:00+09:00', ?)",
        )
        .run(`${trigger}-${status}-${outcome}`, trigger, status, outcome);
    expect(() => insert("schedule", "running", null)).not.toThrow();
    expect(() => insert("cron", "running", null)).toThrow(/CHECK/);
    expect(() => insert("manual", "done", null)).toThrow(/CHECK/);
    expect(() => insert("proposal", "finished", "error")).toThrow(/CHECK/);
    expect(() => insert("proposal", "finished", "skipped")).not.toThrow();
  });
});
