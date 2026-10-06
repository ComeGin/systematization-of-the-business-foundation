import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { type NewRun, type RunFinish, RunStore } from "../../src/store/runs.js";
import { memoryE15 } from "../helpers/store.js";

// run_id は辞書順 = 時系列（ULID）。テストでは並びのわかる固定の値を使う
const id = (n: number) => `01JZ${String(n).padStart(22, "0")}`;

function newRun(n: number, overrides: Partial<NewRun> = {}): NewRun {
  return {
    runId: id(n),
    jobId: "daily-observe-seo",
    agentName: "seo-auditor",
    builtin: null,
    trigger: "schedule",
    startedAt: `2026-10-05T0${n % 10}:00:00.000+09:00`,
    ...overrides,
  };
}

function finish(overrides: Partial<RunFinish> = {}): RunFinish {
  return {
    finishedAt: "2026-10-05T09:30:00.000+09:00",
    outcome: "success",
    summary: "E-12 を 1 件書いた",
    summaryRedacted: false,
    targetIds: ["AUD-2026-1005-lighthouse-0001"],
    skipReason: null,
    failureClass: "ok",
    sdkSubtype: "success",
    costUsd: 0.12,
    ...overrides,
  };
}

let db: DatabaseSync;
let runs: RunStore;

beforeEach(() => {
  db = memoryE15();
  runs = new RunStore(db);
});

describe("RunStore.insertRunning", () => {
  it("running の行を作り、未確定の項目は null・空で返す", () => {
    runs.insertRunning(newRun(1));
    expect(runs.get(id(1))).toEqual({
      runId: id(1),
      jobId: "daily-observe-seo",
      agentName: "seo-auditor",
      builtin: null,
      trigger: "schedule",
      status: "running",
      startedAt: "2026-10-05T01:00:00.000+09:00",
      finishedAt: null,
      outcome: null,
      summary: null,
      summaryRedacted: false,
      targetIds: [],
      skipReason: null,
      failureClass: null,
      sdkSubtype: null,
      costUsd: null,
      copiedAt: null,
    });
  });

  it("同じ run_id は 2 回入れられない", () => {
    runs.insertRunning(newRun(1));
    expect(() => runs.insertRunning(newRun(1))).toThrow();
  });

  it("無い run は get で null", () => {
    expect(runs.get(id(99))).toBeNull();
  });
});

describe("RunStore.finish", () => {
  it("running → finished に確定し、返した値と get の値が一致する", () => {
    runs.insertRunning(newRun(1));
    const result = runs.finish(id(1), finish({ summaryRedacted: true, targetIds: ["a", "b"] }));
    expect(result).toMatchObject({ status: "finished", outcome: "success", summaryRedacted: true, targetIds: ["a", "b"] });
    expect(runs.get(id(1))).toEqual(result);
  });

  it("写し用の snapshot_json を終了時に固め、中身は確定した記録そのもの（copiedAt は null）", () => {
    runs.insertRunning(newRun(1));
    const result = runs.finish(id(1), finish());
    const [pending] = runs.pendingCopies(10);
    expect(pending?.runId).toBe(id(1));
    expect(JSON.parse(pending!.snapshot)).toEqual(result);
    expect(JSON.parse(pending!.snapshot).copiedAt).toBeNull();
  });

  it("無い run は例外にする", () => {
    expect(() => runs.finish(id(1), finish())).toThrow(/run が存在しない/);
  });

  it("確定済みの run は上書きしない（2 回目の finish は DB を変えない）", () => {
    runs.insertRunning(newRun(1));
    runs.finish(id(1), finish({ outcome: "success", summary: "1 回目" }));
    const before = runs.pendingCopies(10)[0]?.snapshot;
    runs.finish(id(1), finish({ outcome: "failure", summary: "2 回目", failureClass: "timeout" }));
    expect(runs.get(id(1))).toMatchObject({ outcome: "success", summary: "1 回目", failureClass: "ok" });
    expect(runs.pendingCopies(10)[0]?.snapshot).toBe(before);
  });

  it("skipped は理由と一緒に記録できる", () => {
    runs.insertRunning(newRun(1));
    runs.finish(id(1), finish({ outcome: "skipped", skipReason: "前回が実行中", failureClass: null, costUsd: null }));
    expect(runs.get(id(1))).toMatchObject({ outcome: "skipped", skipReason: "前回が実行中", failureClass: null });
  });
});

describe("RunStore.list", () => {
  beforeEach(() => {
    runs.insertRunning(newRun(1, { jobId: "a" }));
    runs.insertRunning(newRun(2, { jobId: "b" }));
    runs.insertRunning(newRun(3, { jobId: "a" }));
    runs.finish(id(1), finish({ outcome: "failure" }));
    runs.finish(id(3), finish({ outcome: "success" }));
  });

  it("新しい順（run_id の降順）に返す", () => {
    expect(runs.list().map((r) => r.runId)).toEqual([id(3), id(2), id(1)]);
  });

  it("before・jobId・outcome で絞り込め、組み合わせは AND", () => {
    expect(runs.list({ before: id(3) }).map((r) => r.runId)).toEqual([id(2), id(1)]);
    expect(runs.list({ jobId: "a" }).map((r) => r.runId)).toEqual([id(3), id(1)]);
    expect(runs.list({ outcome: "failure" }).map((r) => r.runId)).toEqual([id(1)]);
    expect(runs.list({ jobId: "a", before: id(3) }).map((r) => r.runId)).toEqual([id(1)]);
  });

  it("limit は 1〜200 に丸める（0 以下は 1 件）", () => {
    expect(runs.list({ limit: 0 })).toHaveLength(1);
    expect(runs.list({ limit: -5 })).toHaveLength(1);
    expect(runs.list({ limit: 2 })).toHaveLength(2);
  });

  it("limit の上限は 200、既定は 50", () => {
    for (let n = 10; n < 260; n++) runs.insertRunning(newRun(n));
    expect(runs.list()).toHaveLength(50);
    expect(runs.list({ limit: 1_000 })).toHaveLength(200);
  });
});

describe("RunStore の検索", () => {
  it("startedSince は指定時刻以降に開始した run を古い順に返す（境界を含む）", () => {
    runs.insertRunning(newRun(1, { startedAt: "2026-10-05T01:00:00.000+09:00" }));
    runs.insertRunning(newRun(2, { startedAt: "2026-10-05T02:00:00.000+09:00" }));
    runs.insertRunning(newRun(3, { startedAt: "2026-10-05T03:00:00.000+09:00" }));
    expect(runs.startedSince("2026-10-05T02:00:00.000+09:00").map((r) => r.runId)).toEqual([id(2), id(3)]);
  });

  it("latestByJob はその job の最新の run（無ければ null）", () => {
    runs.insertRunning(newRun(1, { jobId: "a" }));
    runs.insertRunning(newRun(2, { jobId: "a" }));
    runs.insertRunning(newRun(3, { jobId: "b" }));
    expect(runs.latestByJob("a")?.runId).toBe(id(2));
    expect(runs.latestByJob("zzz")).toBeNull();
  });

  it("hasSuccessSince は success で終わった run だけを数え、時刻より前の成功は見ない", () => {
    runs.insertRunning(newRun(1, { jobId: "a", startedAt: "2026-10-05T01:00:00.000+09:00" }));
    runs.finish(id(1), finish({ outcome: "success" }));
    runs.insertRunning(newRun(2, { jobId: "a", startedAt: "2026-10-05T05:00:00.000+09:00" }));
    runs.finish(id(2), finish({ outcome: "partial" }));
    runs.insertRunning(newRun(3, { jobId: "a", startedAt: "2026-10-05T06:00:00.000+09:00" }));
    expect(runs.hasSuccessSince("a", "2026-10-05T00:00:00.000+09:00")).toBe(true);
    expect(runs.hasSuccessSince("a", "2026-10-05T02:00:00.000+09:00")).toBe(false);
    expect(runs.hasSuccessSince("b", "2026-10-05T00:00:00.000+09:00")).toBe(false);
  });

  it("running は確定していない run だけを古い順に返す", () => {
    runs.insertRunning(newRun(1));
    runs.insertRunning(newRun(2));
    runs.insertRunning(newRun(3));
    runs.finish(id(2), finish());
    expect(runs.running().map((r) => r.runId)).toEqual([id(1), id(3)]);
  });
});

describe("RunStore の写し（pendingCopies / markCopied）", () => {
  it("未送の確定済み run だけを古い順に limit 件返す（running は含めない）", () => {
    for (const n of [1, 2, 3, 4]) runs.insertRunning(newRun(n));
    runs.finish(id(3), finish());
    runs.finish(id(1), finish());
    runs.finish(id(4), finish());
    expect(runs.pendingCopies(10).map((p) => p.runId)).toEqual([id(1), id(3), id(4)]);
    expect(runs.pendingCopies(2).map((p) => p.runId)).toEqual([id(1), id(3)]);
    expect(runs.pendingCopies(1)[0]?.startedAt).toBe(newRun(1).startedAt);
  });

  it("markCopied で未送から外れ、2 回目は最初の時刻を上書きしない", () => {
    runs.insertRunning(newRun(1));
    runs.finish(id(1), finish());
    runs.markCopied(id(1), "2026-10-05T10:00:00.000+09:00");
    runs.markCopied(id(1), "2026-10-05T11:00:00.000+09:00");
    expect(runs.pendingCopies(10)).toEqual([]);
    expect(runs.get(id(1))?.copiedAt).toBe("2026-10-05T10:00:00.000+09:00");
  });

  it("写しの印を付けても snapshot は変わらない（再送でも中身が同じ）", () => {
    runs.insertRunning(newRun(1));
    runs.finish(id(1), finish());
    const before = (db.prepare("SELECT snapshot_json FROM runs").get() as { snapshot_json: string }).snapshot_json;
    runs.markCopied(id(1), "2026-10-05T10:00:00.000+09:00");
    const after = (db.prepare("SELECT snapshot_json FROM runs").get() as { snapshot_json: string }).snapshot_json;
    expect(after).toBe(before);
  });
});
