import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDefinition } from "../src/definitions/schedules.js";
import type { Engine } from "../src/engine.js";
import { Scheduler, nextRunAt } from "../src/scheduler.js";
import { makeConfig, makeCtx, makeJob } from "./helpers/runner.js";

const HOUR = 60 * 60 * 1000;

let ctx: ReturnType<typeof makeCtx>;
let start: ReturnType<typeof vi.fn>;
let scheduler: Scheduler;
let jobs: ScheduleDefinition[];

beforeEach(() => {
  vi.useFakeTimers();
  // 日本時間 2026-10-05 05:59:00（UTC では 10/04 20:59）
  vi.setSystemTime(new Date("2026-10-04T20:59:00Z"));
  jobs = [];
  ctx = makeCtx(makeConfig({ schedulerEnabled: true }));
  vi.mocked(ctx.loadSchedules).mockImplementation(async () => ({ jobs, errors: [] }));
  start = vi.fn(async () => ({ runId: "x", accepted: true }));
  scheduler = new Scheduler(ctx, { start } as unknown as Engine);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
});

describe("Scheduler", () => {
  it("cron 式を Asia/Tokyo で解釈し、時刻になったら schedule としてエンジンを起動する", async () => {
    const job = makeJob({ id: "daily", cron: "0 6 * * *" });
    jobs = [job];
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ trigger: "schedule", job });
  });

  it("enabled: false のジョブは登録しない", async () => {
    jobs = [makeJob({ id: "off", cron: "0 6 * * *", enabled: false })];
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(start).not.toHaveBeenCalled();
  });

  it("1 時間ごとに定義を読み直す（start を 2 回呼んでもタイマーは 1 つ）", async () => {
    await scheduler.start();
    await scheduler.start();
    expect(ctx.loadSchedules).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(ctx.loadSchedules).toHaveBeenCalledTimes(3);
  });

  it("変わっていない定義は登録し直さない（同じ時刻に 2 回起動しない）", async () => {
    jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
    await scheduler.start();
    jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("変わった定義は止めて新しい内容で登録し直す", async () => {
    jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
    await scheduler.start();
    const changed = makeJob({ id: "daily", cron: "5 6 * * *" });
    jobs = [changed];
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ trigger: "schedule", job: changed });
  });

  it("消えた定義・enabled: false になった定義は止める", async () => {
    jobs = [makeJob({ id: "a", cron: "0 6 * * *" }), makeJob({ id: "b", cron: "0 6 * * *" })];
    await scheduler.start();
    jobs = [makeJob({ id: "b", cron: "0 6 * * *", enabled: false })];
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(start).not.toHaveBeenCalled();
  });

  it("定期の読み直しに失敗しても投げず、登録済みのジョブは動き続ける", async () => {
    const job = makeJob({ id: "hourly", cron: "0 * * * *" });
    jobs = [job];
    await scheduler.start();
    vi.mocked(ctx.loadSchedules).mockRejectedValue(new Error("YAML が壊れている"));
    await vi.advanceTimersByTimeAsync(HOUR);
    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("定義の再読み込みに失敗");
    expect(start).toHaveBeenCalled();
  });

  it("stop の後は起動も読み直しもしない", async () => {
    jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
    await scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(start).not.toHaveBeenCalled();
    expect(ctx.loadSchedules).toHaveBeenCalledTimes(1);
  });

  it("止まっていた間の分は取り戻さない（登録より前の時刻の分は起動しない）", async () => {
    vi.setSystemTime(new Date("2026-10-04T21:30:00Z")); // 日本時間 06:30
    jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(start).not.toHaveBeenCalled();
  });

  it("engine.start が reject しても unhandled rejection にせず、ジョブ名と理由をログに出す", async () => {
    start.mockRejectedValue(new Error("database is locked"));
    jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_500);
    expect(start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/daily: 起動に失敗: database is locked/);
  });
});

describe("nextRunAt", () => {
  it("次の起動時刻を日本時間の ISO 8601 で返す", () => {
    vi.setSystemTime(new Date("2026-10-04T21:30:00Z")); // 日本時間 10/05 06:30
    expect(nextRunAt(makeJob({ cron: "0 6 * * *" }))).toBe("2026-10-06T06:00:00.000+09:00");
    expect(nextRunAt(makeJob({ cron: "45 6 * * *" }))).toBe("2026-10-05T06:45:00.000+09:00");
  });
});
