import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceCheck } from "../../src/builtin/silence-check.js";
import type { BuiltinInput } from "../../src/context.js";
import type { RunOutcome } from "../../src/contract.js";
import type { ScheduleDefinition } from "../../src/definitions/schedules.js";
import { makeConfig, makeCtx, makeJob, tempDir, writeAt } from "../helpers/runner.js";

const AUDITS = "docs/audits";
const RUN_ID = "01K6PZ3T8Q4M2N7R9S5V1W3X6Y";

let worktree: string;
let cleanup: () => void;
let ctx: ReturnType<typeof makeCtx>;
let seq = 0;

function setNow(iso: string) {
  vi.setSystemTime(new Date(iso));
}

function run(
  startedAt: string,
  options: { agentName?: string | null; jobId?: string | null; outcome?: RunOutcome; runId?: string; trigger?: "schedule" | "manual" } = {},
) {
  const runId = options.runId ?? `01K6PZ3T8Q4M2N7R9S5V1W3X${String.fromCharCode(65 + seq++)}0`;
  ctx.runs.insertRunning({
    runId,
    jobId: options.jobId ?? null,
    agentName: options.agentName === undefined ? "seo-auditor" : options.agentName,
    builtin: null,
    trigger: options.trigger ?? "schedule",
    startedAt,
  });
  ctx.runs.finish(runId, {
    finishedAt: startedAt,
    outcome: options.outcome ?? "success",
    summary: "s",
    summaryRedacted: false,
    targetIds: [],
    skipReason: null,
    failureClass: null,
    sdkSubtype: null,
    costUsd: null,
  });
}

function withJobs(jobs: ScheduleDefinition[], schedulerEnabled = true) {
  ctx.config.schedulerEnabled = schedulerEnabled;
  vi.mocked(ctx.loadSchedules).mockResolvedValue({ jobs, errors: [] });
}

const input = (): BuiltinInput => ({ ctx, runId: RUN_ID, signal: new AbortController().signal, timeoutSec: 60, job: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow("2026-10-05T12:00:00+09:00");
  ({ dir: worktree, cleanup } = tempDir("cp-silence-"));
  ctx = makeCtx(makeConfig({ worktree }));
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("silenceCheck (a) 成果物なし", () => {
  describe("正常系", () => {
    it("空入力: run も定義も無ければ success", async () => {
      expect(await silenceCheck(input())).toEqual({ outcome: "success", summary: "沈黙の疑いは見つからなかった", targetIds: [] });
    });

    it("success の run があるのに当日分の監査が 1 件も無ければ partial", async () => {
      run("2026-10-05T06:00:00.000+09:00");
      expect(await silenceCheck(input())).toEqual({
        outcome: "partial",
        summary: "沈黙の疑い 1 件: 成果物なし: seo-auditor",
        targetIds: ["agent:seo-auditor"],
      });
    });

    it("空入力: source のディレクトリはあっても中身が空なら、当日分が無いとして検出する", async () => {
      run("2026-10-05T06:00:00.000+09:00");
      mkdirSync(join(worktree, AUDITS, "gsc"), { recursive: true });
      expect((await silenceCheck(input())).targetIds).toEqual(["agent:seo-auditor"]);
    });

    it("そのエージェントの source のどれか 1 つに当日分があれば検出しない", async () => {
      run("2026-10-05T06:00:00.000+09:00");
      writeAt(worktree, `${AUDITS}/gsc/AUD-2026-1005-gsc-0001.md`, "x");
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("前日分・別の source の名前のファイルは当日分として数えない", async () => {
      run("2026-10-05T06:00:00.000+09:00");
      writeAt(worktree, `${AUDITS}/gsc/AUD-2026-1004-gsc-0001.md`, "x");
      writeAt(worktree, `${AUDITS}/gsc/AUD-2026-1005-serp-0001.md`, "x");
      expect((await silenceCheck(input())).outcome).toBe("partial");
    });

    it.each(["failure", "partial", "skipped"] as const)("outcome=%s の run だけなら検出しない", async (outcome) => {
      run("2026-10-05T06:00:00.000+09:00", { outcome });
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("docs/audits に書かないエージェント（proposal-writer など）は対象外", async () => {
      run("2026-10-05T06:00:00.000+09:00", { agentName: "proposal-writer" });
      run("2026-10-05T06:00:00.000+09:00", { agentName: null });
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("当日は日本時間の 0 時から（前日 23 時台の run は数えない）", async () => {
      setNow("2026-10-05T00:30:00+09:00");
      run("2026-10-04T23:50:00.000+09:00");
      expect((await silenceCheck(input())).outcome).toBe("success");
      run("2026-10-05T00:00:00.000+09:00");
      expect((await silenceCheck(input())).outcome).toBe("partial");
    });

    it("日本時間の日付で当日分のファイル名を判定する（UTC では前日でも）", async () => {
      setNow("2026-10-05T08:00:00+09:00"); // UTC では 10/04 23:00
      run("2026-10-05T07:00:00.000+09:00", { agentName: "ops-watcher" });
      writeAt(worktree, `${AUDITS}/ops/AUD-2026-1005-ops-0001.md`, "x");
      expect((await silenceCheck(input())).outcome).toBe("success");
    });
  });

  describe("異常系", () => {
    it("入力: docs/audits/<source> がディレクトリでなくファイルなら、読めない理由（ENOTDIR）をそのまま投げる", async () => {
      run("2026-10-05T06:00:00.000+09:00");
      writeAt(worktree, `${AUDITS}/gsc`, "not a directory");
      await expect(silenceCheck(input())).rejects.toMatchObject({ code: "ENOTDIR" });
    });
  });
});

describe("silenceCheck (b) 未起動", () => {
  const job = makeJob({ id: "daily-silence", cron: "0 6 * * *" });

  describe("正常系", () => {
    it("空入力: スケジューラが有効でも定義が 0 件なら success", async () => {
      withJobs([]);
      expect(await silenceCheck(input())).toEqual({ outcome: "success", summary: "沈黙の疑いは見つからなかった", targetIds: [] });
      expect(ctx.loadSchedules).toHaveBeenCalledTimes(1);
    });

    it("起動時刻 + 猶予 10 分を過ぎても run が無ければ検出する", async () => {
      setNow("2026-10-05T06:10:00+09:00");
      withJobs([job]);
      expect(await silenceCheck(input())).toEqual({
        outcome: "partial",
        summary: "沈黙の疑い 1 件: 未起動: daily-silence（06:00）",
        targetIds: ["job:daily-silence"],
      });
    });

    it("猶予の 10 分以内なら検出しない", async () => {
      setNow("2026-10-05T06:09:59+09:00");
      withJobs([job]);
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("skipped を含め、起動時刻の 1 分前以降に run があれば起動したとみなす", async () => {
      withJobs([job]);
      run("2026-10-05T05:59:00.000+09:00", { jobId: "daily-silence", agentName: null, outcome: "skipped" });
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("起動時刻の 1 分より前の run は、その起動として数えない", async () => {
      withJobs([job]);
      run("2026-10-05T05:58:59.999+09:00", { jobId: "daily-silence", agentName: null });
      expect((await silenceCheck(input())).summary).toContain("未起動: daily-silence（06:00）");
    });

    it("1 日に複数回のジョブは、過ぎた起動時刻ごとに判定する", async () => {
      setNow("2026-10-05T13:00:00+09:00");
      withJobs([makeJob({ id: "every-6h", cron: "0 */6 * * *" })]);
      run("2026-10-05T00:00:01.000+09:00", { jobId: "every-6h", agentName: null });
      run("2026-10-05T06:00:01.000+09:00", { jobId: "every-6h", agentName: null });
      const result = await silenceCheck(input());
      expect(result.summary).toBe("沈黙の疑い 1 件: 未起動: every-6h（12:00）");
      expect(result.targetIds).toEqual(["job:every-6h"]);
    });

    it("1 日に複数回のジョブで、後の起動の run は前の起動の欠落を隠さない（起動時刻ごとの窓で判定する）", async () => {
      setNow("2026-10-05T13:00:00+09:00");
      withJobs([makeJob({ id: "every-6h", cron: "0 */6 * * *" })]);
      // 00:00 と 12:00 は起動したが、06:00 の起動が無い
      run("2026-10-05T00:00:01.000+09:00", { jobId: "every-6h", agentName: null });
      run("2026-10-05T12:00:01.000+09:00", { jobId: "every-6h", agentName: null });
      expect((await silenceCheck(input())).summary).toBe("沈黙の疑い 1 件: 未起動: every-6h（06:00）");
    });

    it("毎分のジョブでも、数秒遅れの run はその起動に数え、次の起動の窓に入れない", async () => {
      setNow("2026-10-05T00:14:00+09:00");
      withJobs([makeJob({ id: "every-minute", cron: "* * * * *" })]);
      // 00:00〜00:03 の 4 回はそれぞれ 5 秒遅れで起動、00:04 だけ欠落（猶予 10 分を過ぎた起動時刻は 00:00〜00:04）
      for (const minute of ["00", "01", "02", "03"]) run(`2026-10-05T00:${minute}:05.000+09:00`, { jobId: "every-minute", agentName: null });
      expect((await silenceCheck(input())).summary).toBe("沈黙の疑い 1 件: 未起動: every-minute（00:04）");
    });

    it("手動の run（trigger=manual）も、そのジョブの起動として数える", async () => {
      withJobs([job]);
      run("2026-10-05T06:03:00.000+09:00", { jobId: "daily-silence", agentName: null, trigger: "manual" });
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("enabled: false のジョブ・スケジューラが無効なときは見ない", async () => {
      withJobs([makeJob({ id: "off", enabled: false })]);
      expect((await silenceCheck(input())).outcome).toBe("success");
      withJobs([job], false);
      expect((await silenceCheck(input())).outcome).toBe("success");
      expect(ctx.loadSchedules).toHaveBeenCalledTimes(1);
    });

    it("自分自身の run は数えない", async () => {
      withJobs([job]);
      run("2026-10-05T06:00:00.000+09:00", { jobId: "daily-silence", agentName: null, runId: RUN_ID });
      expect((await silenceCheck(input())).outcome).toBe("partial");
    });
  });

  describe("異常系", () => {
    it("入力: 読めなかった定義（errors）だけなら未起動として扱わず success（定義の不備は schedules 側が WARN を出す）", async () => {
      ctx.config.schedulerEnabled = true;
      vi.mocked(ctx.loadSchedules).mockResolvedValue({ jobs: [], errors: [{ file: "broken.yaml", reason: "cron: 5 フィールド" }] });
      expect((await silenceCheck(input())).outcome).toBe("success");
    });

    it("入力: 定義の読み込みが例外なら、そのまま投げる（握りつぶして success にしない）", async () => {
      ctx.config.schedulerEnabled = true;
      vi.mocked(ctx.loadSchedules).mockRejectedValue(new Error("EACCES: ops/schedules"));
      await expect(silenceCheck(input())).rejects.toThrow("EACCES");
    });
  });
});
