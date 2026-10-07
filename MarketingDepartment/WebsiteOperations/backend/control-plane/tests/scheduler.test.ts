// エンジンは start だけを持つ偽物、定義の読み込みは vi.fn、時刻は偽物のタイマーで進める（croner のタイマーも偽物の上で動く）。
// E-15 は makeCtx の :memory: の SQLite（スケジューラ自身は触らない）。
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

const loggedText = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");

describe("Scheduler", () => {
  describe("正常系", () => {
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

    it("空入力: 定義が 0 件なら何も登録せず、読み直しのタイマーだけを動かす", async () => {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(24 * HOUR);
      expect(start).not.toHaveBeenCalled();
      expect(ctx.loadSchedules).toHaveBeenCalledTimes(25);
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

    it("空入力: 読み直しで定義が 0 件になれば、登録済みのジョブをすべて止める", async () => {
      jobs = [makeJob({ id: "a", cron: "0 6 * * *" })];
      await scheduler.start();
      jobs = [];
      await scheduler.reload();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(start).not.toHaveBeenCalled();
    });

    it("stop の後は起動も読み直しもしない", async () => {
      jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
      await scheduler.start();
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(start).not.toHaveBeenCalled();
      expect(ctx.loadSchedules).toHaveBeenCalledTimes(1);
    });

    it("空入力: start の前に stop しても落ちない", () => {
      expect(() => scheduler.stop()).not.toThrow();
    });

    it("止まっていた間の分は取り戻さない（登録より前の時刻の分は起動しない）", async () => {
      vi.setSystemTime(new Date("2026-10-04T21:30:00Z")); // 日本時間 06:30
      jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: 定期の読み直しに失敗しても投げず、登録済みのジョブは動き続ける", async () => {
      const job = makeJob({ id: "hourly", cron: "0 * * * *" });
      jobs = [job];
      await scheduler.start();
      vi.mocked(ctx.loadSchedules).mockRejectedValue(new Error("YAML が壊れている"));
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(loggedText()).toContain("定義の再読み込みに失敗");
      expect(start).toHaveBeenCalled();
    });

    it("サーバ: 初回の読み込みに失敗したら start は reject し、読み直しのタイマーも作らない", async () => {
      vi.mocked(ctx.loadSchedules).mockRejectedValueOnce(new Error("EACCES"));
      await expect(scheduler.start()).rejects.toThrow("EACCES");
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(ctx.loadSchedules).toHaveBeenCalledTimes(1);
      // 原因を直して start し直せば動く
      jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
      vi.setSystemTime(new Date("2026-10-05T20:59:00Z"));
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(start).toHaveBeenCalledTimes(1);
    });

    it("サーバ: engine.start が reject しても unhandled rejection にせず、ジョブ名と理由をログに出す", async () => {
      start.mockRejectedValue(new Error("database is locked"));
      jobs = [makeJob({ id: "daily", cron: "0 6 * * *" })];
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(60_500);
      expect(start).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(/daily: 起動に失敗: database is locked/);
    });

    it("サーバ: engine.start が 1 回失敗しても、次の時刻には起動する", async () => {
      start.mockRejectedValueOnce(new Error("database is locked"));
      jobs = [makeJob({ id: "hourly", cron: "0 * * * *" })];
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(HOUR + 60_500);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });
});

describe("nextRunAt", () => {
  describe("正常系", () => {
    it("次の起動時刻を日本時間の ISO 8601 で返す", () => {
      vi.setSystemTime(new Date("2026-10-04T21:30:00Z")); // 日本時間 10/05 06:30
      expect(nextRunAt(makeJob({ cron: "0 6 * * *" }))).toBe("2026-10-06T06:00:00.000+09:00");
      expect(nextRunAt(makeJob({ cron: "45 6 * * *" }))).toBe("2026-10-05T06:45:00.000+09:00");
    });

    it("起動する日が来ない式（2 月 30 日）は null", () => {
      expect(nextRunAt(makeJob({ cron: "0 0 30 2 *" }))).toBeNull();
    });
  });

  describe("異常系", () => {
    it("空入力: cron 式が空文字なら例外を投げる", () => {
      expect(() => nextRunAt(makeJob({ cron: "" }))).toThrow(TypeError);
    });

    it("入力: cron 式でない文字列は例外を投げる（定義の読み込みで先に弾く前提）", () => {
      expect(() => nextRunAt(makeJob({ cron: "every day" }))).toThrow(TypeError);
    });
  });
});
