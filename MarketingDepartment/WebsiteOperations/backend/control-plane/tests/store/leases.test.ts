import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openE15Database } from "../../src/store/db.js";
import { LeaseStore } from "../../src/store/leases.js";
import { makeTempDir, memoryE15 } from "../helpers/store.js";

const OTHER_PID = 4_000_000;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** 別のプロセスが持っているリースを直接書く。 */
function putForeignLease(db: DatabaseSync, key: string, runId: string, expiresAt: number, pid = OTHER_PID): void {
  db.prepare("INSERT INTO leases (lease_key, run_id, pid, acquired_at, expires_at) VALUES (?, ?, ?, 0, ?)").run(
    key,
    runId,
    pid,
    expiresAt,
  );
}

function leaseRow(db: DatabaseSync, key: string) {
  return db.prepare("SELECT run_id, pid, acquired_at, expires_at FROM leases WHERE lease_key = ?").get(key) as
    | { run_id: string; pid: number; acquired_at: number; expires_at: number }
    | undefined;
}

let db: DatabaseSync;
let leases: LeaseStore;

beforeEach(() => {
  db = memoryE15();
  leases = new LeaseStore(db);
});

describe("LeaseStore.acquire", () => {
  it("空いていれば取れて、自分の pid と期限（now + ttl）を記録する", () => {
    expect(leases.acquire("job:a", "R1", 5_000, 1_000)).toBe(true);
    expect(leaseRow(db, "job:a")).toEqual({ run_id: "R1", pid: process.pid, acquired_at: 1_000, expires_at: 6_000 });
  });

  it("期限内のリースは同じプロセスからでも取れない（前回が実行中なら見送る）", () => {
    leases.acquire("job:a", "R1", 5_000, 1_000);
    expect(leases.acquire("job:a", "R2", 5_000, 2_000)).toBe(false);
    expect(leaseRow(db, "job:a")?.run_id).toBe("R1");
  });

  it("キーが違えば互いに干渉しない", () => {
    expect(leases.acquire("job:a", "R1", 5_000, 1_000)).toBe(true);
    expect(leases.acquire("job:b", "R2", 5_000, 1_000)).toBe(true);
  });

  it("期限ちょうど（expires_at == now）からは奪える。1 ミリ秒前はまだ奪えない", () => {
    leases.acquire("job:a", "R1", 1_000, 0);
    expect(leases.acquire("job:a", "R2", 1_000, 999)).toBe(false);
    expect(leases.acquire("job:a", "R2", 1_000, 1_000)).toBe(true);
    expect(leaseRow(db, "job:a")).toMatchObject({ run_id: "R2", expires_at: 2_000 });
  });

  it("期限内でも、持ち主のプロセスが死んでいれば（ESRCH）奪える", () => {
    putForeignLease(db, "job:a", "R1", 10_000);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw errno("ESRCH");
    });
    expect(leases.acquire("job:a", "R2", 1_000, 0)).toBe(true);
    expect(kill).toHaveBeenCalledWith(OTHER_PID, 0);
    expect(leaseRow(db, "job:a")).toMatchObject({ run_id: "R2", pid: process.pid });
  });

  it("持ち主が生きていれば（kill(pid, 0) が通る）奪えない", () => {
    putForeignLease(db, "job:a", "R1", 10_000);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(leases.acquire("job:a", "R2", 1_000, 0)).toBe(false);
  });

  it("EPERM は「別ユーザーのプロセスが生きている」とみなし、奪わない", () => {
    putForeignLease(db, "job:a", "R1", 10_000);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errno("EPERM");
    });
    expect(leases.acquire("job:a", "R2", 1_000, 0)).toBe(false);
  });

  it("期限切れなら持ち主の生死を確かめずに奪う", () => {
    putForeignLease(db, "job:a", "R1", 100);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(leases.acquire("job:a", "R2", 1_000, 100)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("同じファイルを開いた 2 つの接続の間でも排他になる", () => {
    const temp = makeTempDir();
    try {
      const first = openE15Database(temp.dir);
      const second = new DatabaseSync(join(temp.dir, "e15.sqlite"));
      second.exec("PRAGMA busy_timeout = 5000");
      expect(new LeaseStore(first).acquire("job:a", "R1", 60_000)).toBe(true);
      expect(new LeaseStore(second).acquire("job:a", "R2", 60_000)).toBe(false);
      first.close();
      second.close();
    } finally {
      temp.cleanup();
    }
  });
});

describe("LeaseStore.release / releaseByRun", () => {
  it("release は run_id が一致するときだけ消す（奪われた後に前の持ち主が消さない）", () => {
    leases.acquire("job:a", "R1", 1_000, 0);
    leases.acquire("job:a", "R2", 1_000, 1_000);
    leases.release("job:a", "R1");
    expect(leaseRow(db, "job:a")?.run_id).toBe("R2");
    leases.release("job:a", "R2");
    expect(leaseRow(db, "job:a")).toBeUndefined();
    expect(leases.acquire("job:a", "R3", 1_000, 1_500)).toBe(true);
  });

  it("releaseByRun は run_id で消す", () => {
    leases.acquire("job:a", "R1", 1_000, 0);
    leases.acquire("job:b", "R2", 1_000, 0);
    leases.releaseByRun("R1");
    expect(leaseRow(db, "job:a")).toBeUndefined();
    expect(leaseRow(db, "job:b")?.run_id).toBe("R2");
  });
});

describe("LeaseStore.heldElsewhere", () => {
  it("リースが無ければ false", () => {
    expect(leases.heldElsewhere("R1", 0)).toBe(false);
  });

  it("自分のプロセスのリースは false（起動時の中断判定で自分を除く）", () => {
    leases.acquire("job:a", "R1", 10_000, 0);
    expect(leases.heldElsewhere("R1", 1)).toBe(false);
  });

  it("他のプロセスが期限内で生きていれば true", () => {
    putForeignLease(db, "job:a", "R1", 10_000);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(leases.heldElsewhere("R1", 0)).toBe(true);
  });

  it("他のプロセスでも、期限切れか死んでいれば false", () => {
    putForeignLease(db, "job:a", "R1", 10_000);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(leases.heldElsewhere("R1", 10_000)).toBe(false);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errno("ESRCH");
    });
    expect(leases.heldElsewhere("R1", 0)).toBe(false);
  });
});

afterEach(() => {
  if (db.isOpen) db.close();
});
