import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunLogCopier, runLogKey } from "../../src/integrations/runlog.js";
import type { RunStore } from "../../src/store/runs.js";
import { deferred, memoryStores } from "../helpers/runner.js";

const aws = { region: "ap-northeast-1", profile: null, runlogBucket: "comegin-runlog", heartbeatNamespace: "ComeGin/Onprem" };

let runs: RunStore;
let send: ReturnType<typeof vi.spyOn>;

function finishedRun(runId: string, startedAt: string, summary = "要約"): void {
  runs.insertRunning({ runId, jobId: "j", agentName: null, builtin: "silence-check", trigger: "schedule", startedAt });
  runs.finish(runId, {
    finishedAt: startedAt,
    outcome: "success",
    summary,
    summaryRedacted: false,
    targetIds: [],
    skipReason: null,
    failureClass: null,
    sdkSubtype: null,
    costUsd: null,
  });
}

const sentCommands = () => send.mock.calls.map((call) => call[0] as PutObjectCommand);

beforeEach(() => {
  ({ runs } = memoryStores());
  send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({}));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("runLogKey", () => {
  it("runs/YYYY/MM/DD/<ULID>.json（日付は startedAt の日本時間）", () => {
    expect(runLogKey("01K6PZ3T8Q4M2N7R9S5V1W3X6Y", "2026-10-05T00:30:00.000+09:00")).toBe(
      "runs/2026/10/05/01K6PZ3T8Q4M2N7R9S5V1W3X6Y.json",
    );
  });
});

describe("RunLogCopier.flush", () => {
  it("未送の run を古い順に、単発の PutObject と If-None-Match: * で写し、印を付ける", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6B", "2026-10-04T06:00:00.000+09:00");
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-03T06:00:00.000+09:00");
    runs.insertRunning({ runId: "01K6PZ3T8Q4M2N7R9S5V1W3X6C", jobId: null, agentName: "x", builtin: null, trigger: "manual", startedAt: "2026-10-04T07:00:00.000+09:00" });

    const result = await new RunLogCopier(runs, aws).flush();

    expect(result).toEqual({ sent: 2, alreadyCopied: 0, remaining: 0, failureClass: null });
    const commands = sentCommands();
    expect(commands.map((c) => c.input.Key)).toEqual([
      "runs/2026/10/03/01K6PZ3T8Q4M2N7R9S5V1W3X6A.json",
      "runs/2026/10/04/01K6PZ3T8Q4M2N7R9S5V1W3X6B.json",
    ]);
    for (const command of commands) {
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({ Bucket: "comegin-runlog", IfNoneMatch: "*", ContentType: "application/json" });
    }
    expect(JSON.parse(String(commands[0]!.input.Body))).toMatchObject({ runId: "01K6PZ3T8Q4M2N7R9S5V1W3X6A", status: "finished" });
    expect(runs.get("01K6PZ3T8Q4M2N7R9S5V1W3X6A")!.copiedAt).not.toBeNull();
    expect(runs.pendingCopies(10)).toEqual([]);
  });

  it("412（既に同じキーがある）は写し済みとして印だけ付ける", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-04T06:00:00.000+09:00");
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6B", "2026-10-04T06:00:00.000+09:00");
    send
      .mockRejectedValueOnce(Object.assign(new Error("x"), { $metadata: { httpStatusCode: 412 } }))
      .mockRejectedValueOnce(Object.assign(new Error("x"), { name: "PreconditionFailed" }));
    const result = await new RunLogCopier(runs, aws).flush();
    expect(result).toEqual({ sent: 0, alreadyCopied: 2, remaining: 0, failureClass: null });
    expect(runs.pendingCopies(10)).toEqual([]);
  });

  it("403 は permission_denied でその回の送信を止め、残りは次の機会に古い順から送り直す", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-04T06:00:00.000+09:00");
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6B", "2026-10-04T06:00:00.000+09:00");
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6C", "2026-10-04T06:00:00.000+09:00");
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
    const copier = new RunLogCopier(runs, aws);

    expect(await copier.flush()).toEqual({ sent: 1, alreadyCopied: 0, remaining: 2, failureClass: "permission_denied" });
    expect(send).toHaveBeenCalledTimes(2);

    send.mockClear();
    expect(await copier.flush()).toEqual({ sent: 2, alreadyCopied: 0, remaining: 0, failureClass: null });
    expect(sentCommands()[0]!.input.Key).toContain("01K6PZ3T8Q4M2N7R9S5V1W3X6B");
  });

  it("1 MiB を超えるスナップショットは写さず invalid_response にし、他の run は写す", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-04T06:00:00.000+09:00", "x".repeat(1024 * 1024));
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6B", "2026-10-04T06:00:00.000+09:00");
    const result = await new RunLogCopier(runs, aws).flush();
    expect(result).toMatchObject({ sent: 1, failureClass: "invalid_response" });
    expect(sentCommands().map((c) => c.input.Key)).toEqual(["runs/2026/10/04/01K6PZ3T8Q4M2N7R9S5V1W3X6B.json"]);
    expect(runs.get("01K6PZ3T8Q4M2N7R9S5V1W3X6A")!.copiedAt).toBeNull();
  });

  it("写す内容は終了時に固めたスナップショットで、再送でも変わらない", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-04T06:00:00.000+09:00");
    const snapshot = runs.pendingCopies(1)[0]!.snapshot;
    send.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    const copier = new RunLogCopier(runs, aws);
    expect((await copier.flush()).failureClass).toBe("unreachable");
    await copier.flush();
    expect(sentCommands().map((c) => c.input.Body)).toEqual([snapshot, snapshot]);
  });

  it("同時に 2 回呼んでも 1 回分しか送らず、同じ結果を待つ", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-04T06:00:00.000+09:00");
    const gate = deferred<object>();
    send.mockImplementationOnce(() => gate.promise);
    const copier = new RunLogCopier(runs, aws);
    const first = copier.flush();
    const second = copier.flush();
    expect(second).toBe(first);
    gate.resolve({});
    expect(await first).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("打ち切られていれば送らず、残りの件数を返す", async () => {
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6A", "2026-10-04T06:00:00.000+09:00");
    finishedRun("01K6PZ3T8Q4M2N7R9S5V1W3X6B", "2026-10-04T06:00:00.000+09:00");
    const stop = new AbortController();
    stop.abort();
    expect(await new RunLogCopier(runs, aws).flush(stop.signal)).toEqual({
      sent: 0,
      alreadyCopied: 0,
      remaining: 2,
      failureClass: null,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
