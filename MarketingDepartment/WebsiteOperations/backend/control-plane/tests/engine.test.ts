import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinInput, RunResult } from "../src/context.js";
import type { BuiltinJob } from "../src/contract.js";
import { Engine } from "../src/engine.js";
import type { RunLogCopier } from "../src/integrations/runlog.js";
import type { AgentRunInput } from "../src/runner/agent.js";
import { ULID_PATTERN } from "../src/ulid.js";
import { deferred, makeConfig, makeCtx, makeJob, proposalText, tempDir, writeAt } from "./helpers/runner.js";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  handlers: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("../src/runner/agent.js", () => ({ runAgent: mocks.runAgent }));
vi.mock("../src/builtin/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/builtin/index.js")>()),
  BUILTIN_HANDLERS: mocks.handlers,
}));

const PROPOSALS = "MarketingDepartment/WebsiteOperations/docs/proposals";
const BUILTINS: BuiltinJob[] = ["heartbeat", "i13-file", "miswrite-check", "silence-check", "lighthouse", "published-article-check", "runlog-flush"];

let root: string;
let cleanup: () => void;
let ctx: ReturnType<typeof makeCtx>;
let engine: Engine;

const ok = (summary = "完了"): RunResult => ({ outcome: "success", summary, targetIds: [] });

function writeAgent(name: string) {
  writeAt(join(root, "main"), `.claude/agents/${name}.md`, `---\nname: ${name}\ndescription: d\ntools: Read, Write\n---\n本文\n`);
}

async function finished(runId: string) {
  await vi.waitFor(() => expect(ctx.runs.get(runId)?.status).toBe("finished"));
  return ctx.runs.get(runId)!;
}

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-engine-"));
  ctx = makeCtx(
    makeConfig({ mainCheckout: join(root, "main"), worktree: join(root, "wt"), anthropic: { apiKey: "sk-ant-test" } }),
  );
  engine = new Engine(ctx);
  for (const builtin of BUILTINS) mocks.handlers[builtin] = vi.fn(async () => ok());
  mocks.runAgent.mockImplementation(async () => ok("エージェントが完了"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Engine.start の起動の流れ", () => {
  it("running の行を先に書いてから実行し、結果で確定してリースを返す", async () => {
    let seenDuringRun: unknown;
    mocks.handlers["silence-check"]!.mockImplementation(async ({ runId }: BuiltinInput) => {
      seenDuringRun = ctx.runs.get(runId);
      return ok("沈黙なし");
    });
    const accepted = await engine.start({ trigger: "schedule", job: makeJob() });
    expect(accepted.accepted).toBe(true);
    expect(accepted.runId).toMatch(ULID_PATTERN);

    const record = await finished(accepted.runId);
    expect(seenDuringRun).toMatchObject({ status: "running", outcome: null, jobId: "sample-job", builtin: "silence-check" });
    expect(record).toMatchObject({ status: "finished", outcome: "success", summary: "沈黙なし", trigger: "schedule" });
    expect(ctx.leases.acquire("job:sample-job", "other", 1_000)).toBe(true);
  });

  it("リース時間は timeout_sec + 60 秒", async () => {
    const acquire = vi.spyOn(ctx.leases, "acquire");
    const { runId } = await engine.start({ trigger: "schedule", job: makeJob({ timeoutSec: 120 }) });
    expect(acquire).toHaveBeenCalledWith("job:sample-job", runId, 180_000);
    await finished(runId);
  });

  it("builtin に runId・打ち切りの signal・timeout_sec・定義を渡す", async () => {
    const job = makeJob({ timeoutSec: 45 });
    const { runId } = await engine.start({ trigger: "schedule", job });
    await finished(runId);
    const args = mocks.handlers["silence-check"]!.mock.calls[0]![0] as BuiltinInput;
    expect(args).toMatchObject({ runId, timeoutSec: 45, job });
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("完了を待たずに返す", async () => {
    const gate = deferred<RunResult>();
    mocks.handlers["silence-check"]!.mockReturnValue(gate.promise);
    const { runId, accepted } = await engine.start({ trigger: "manual", job: makeJob() });
    expect(accepted).toBe(true);
    expect(ctx.runs.get(runId)!.status).toBe("running");
    expect(engine.activeCount).toBe(1);
    gate.resolve(ok());
    await finished(runId);
    await vi.waitFor(() => expect(engine.activeCount).toBe(0));
  });

  it("終了時と見送り時に S3 への写しを試み、写しの失敗は実行の記録に影響しない", async () => {
    const flush = vi.fn(async () => {
      throw new Error("S3 down");
    });
    ctx.copier = { flush } as unknown as RunLogCopier;
    const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
    expect((await finished(runId)).outcome).toBe("success");
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    await engine.start({ trigger: "schedule", job: makeJob({ builtin: "i13-file" }) });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
  });
});

describe("Engine.start の多重起動防止", () => {
  it("前回が実行中なら起動を見送り、skipped を記録して accepted=false を返す", async () => {
    const gate = deferred<RunResult>();
    mocks.handlers["silence-check"]!.mockReturnValueOnce(gate.promise);
    const first = await engine.start({ trigger: "schedule", job: makeJob() });
    const second = await engine.start({ trigger: "schedule", job: makeJob() });

    expect(second.accepted).toBe(false);
    expect(ctx.runs.get(second.runId)).toMatchObject({
      status: "finished",
      outcome: "skipped",
      skipReason: "前回の実行が継続中のため起動を見送った",
      jobId: "sample-job",
      builtin: "silence-check",
    });
    expect(mocks.handlers["silence-check"]).toHaveBeenCalledTimes(1);

    gate.resolve(ok());
    await finished(first.runId);
    expect((await engine.start({ trigger: "schedule", job: makeJob() })).accepted).toBe(true);
  });

  it("手動で定義を起動しても、同じ定義の定期実行と同じ印を使う", async () => {
    const gate = deferred<RunResult>();
    mocks.handlers["silence-check"]!.mockReturnValueOnce(gate.promise);
    await engine.start({ trigger: "schedule", job: makeJob() });
    expect((await engine.start({ trigger: "manual", job: makeJob() })).accepted).toBe(false);
    gate.resolve(ok());
  });

  it("別の定義は同時に起動できる", async () => {
    const gate = deferred<RunResult>();
    mocks.handlers["silence-check"]!.mockReturnValue(gate.promise);
    await engine.start({ trigger: "schedule", job: makeJob({ id: "a" }) });
    expect((await engine.start({ trigger: "schedule", job: makeJob({ id: "b" }) })).accepted).toBe(true);
    gate.resolve(ok());
  });

  it("手動のエージェント起動は同じエージェント名で重ねない", async () => {
    writeAgent("seo-auditor");
    const gate = deferred<RunResult>();
    mocks.runAgent.mockReturnValueOnce(gate.promise);
    const first = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
    const second = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
    expect([first.accepted, second.accepted]).toEqual([true, false]);
    expect(ctx.runs.get(second.runId)!.agentName).toBe("seo-auditor");
    gate.resolve(ok());
  });
});

describe("Engine.start の見送りの判定", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T07:00:00+09:00"));
  });

  function dependencyRun(startedAt: string, outcome: "success" | "failure") {
    const runId = `01K6PZ3T8Q4M2N7R9S5V1W3X${outcome === "success" ? "A" : "B"}${startedAt.slice(9, 10)}`;
    ctx.runs.insertRunning({ runId, jobId: "dep", agentName: null, builtin: "lighthouse", trigger: "schedule", startedAt });
    ctx.runs.finish(runId, {
      finishedAt: startedAt,
      outcome,
      summary: "s",
      summaryRedacted: false,
      targetIds: [],
      skipReason: null,
      failureClass: null,
      sdkSubtype: null,
      costUsd: null,
    });
  }

  it("after のジョブが当日に success で終わっていなければ見送る", async () => {
    dependencyRun("2026-10-05T06:00:00.000+09:00", "failure");
    dependencyRun("2026-10-04T06:00:00.000+09:00", "success");
    const result = await engine.start({ trigger: "schedule", job: makeJob({ after: ["dep"] }) });
    expect(result.accepted).toBe(false);
    expect(ctx.runs.get(result.runId)!.skipReason).toBe("after が未達（当日に success が無い: dep）");
    expect(mocks.handlers["silence-check"]).not.toHaveBeenCalled();
  });

  it("after のジョブが当日（日本時間）に success なら起動する", async () => {
    dependencyRun("2026-10-05T00:00:00.000+09:00", "success");
    expect((await engine.start({ trigger: "schedule", job: makeJob({ after: ["dep"] }) })).accepted).toBe(true);
  });

  it("手動の起動は after を見ない（人の判断）", async () => {
    expect((await engine.start({ trigger: "manual", job: makeJob({ after: ["dep"] }) })).accepted).toBe(true);
  });

  it("builtin に必要な設定が無ければ、変数名だけを理由にして見送る", async () => {
    const result = await engine.start({ trigger: "schedule", job: makeJob({ builtin: "i13-file" }) });
    expect(result.accepted).toBe(false);
    expect(ctx.runs.get(result.runId)!.skipReason).toBe(
      "設定が無いため見送った（GITHUB_TOKEN, GITHUB_REPOSITORY, I13_ISSUE_NUMBER, I13_REVIEWER）",
    );
    expect(mocks.handlers["i13-file"]).not.toHaveBeenCalled();
  });

  it("builtin の指定が無い定義・定義もエージェントも無い依頼は見送る", async () => {
    const noBuiltin = await engine.start({ trigger: "schedule", job: makeJob({ builtin: null }) });
    expect(ctx.runs.get(noBuiltin.runId)!.skipReason).toBe("builtin の指定が無い");
    const empty = await engine.start({ trigger: "manual" });
    expect(ctx.runs.get(empty.runId)).toMatchObject({ outcome: "skipped", skipReason: "builtin の指定が無い" });
  });

  it("ANTHROPIC_API_KEY が無ければエージェントを見送る", async () => {
    ctx.config.anthropic = null;
    const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
    expect(ctx.runs.get(result.runId)!.skipReason).toBe("設定が無いため見送った（ANTHROPIC_API_KEY）");
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("エージェント定義が main に無ければ見送る", async () => {
    const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
    expect(ctx.runs.get(result.runId)!.skipReason).toBe("エージェント定義が見つからない: seo-auditor");
  });

  it("プロンプトが空白だけなら見送る", async () => {
    writeAgent("seo-auditor");
    const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "   " } });
    expect(ctx.runs.get(result.runId)!.skipReason).toBe("エージェント名またはプロンプトが無い");
  });

  it("準備中の想定外の例外は、詳細を記録せず見送りにする", async () => {
    mkdirSync(join(root, "main/.claude/agents/seo-auditor.md"), { recursive: true }); // 読むと EISDIR
    const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
    const record = ctx.runs.get(result.runId)!;
    expect(record).toMatchObject({ outcome: "skipped", skipReason: "起動の準備に失敗したため見送った" });
    expect(JSON.stringify(record)).not.toContain("EISDIR");
  });
});

describe("Engine.start のエージェントの起動", () => {
  it("定義の timeout_sec・max_turns と、E-15 と同じ startedAt を runAgent に渡す", async () => {
    writeAgent("seo-auditor");
    const job = makeJob({ kind: "agent", agent: "seo-auditor", builtin: null, prompt: "監査して", timeoutSec: 300, maxTurns: 12 });
    const { runId } = await engine.start({ trigger: "schedule", job });
    const record = await finished(runId);
    const args = mocks.runAgent.mock.calls[0]![0] as AgentRunInput;
    expect(args).toMatchObject({ runId, startedAt: record.startedAt, prompt: "監査して", timeoutSec: 300, maxTurns: 12 });
    expect(args.definition.name).toBe("seo-auditor");
    expect(record).toMatchObject({ agentName: "seo-auditor", jobId: job.id, builtin: null, summary: "エージェントが完了" });
  });

  it("手動の起動は既定（900 秒・40 ターン）を使う", async () => {
    writeAgent("seo-auditor");
    const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
    await finished(runId);
    expect(mocks.runAgent.mock.calls[0]![0]).toMatchObject({ timeoutSec: 900, maxTurns: 40 });
    expect(ctx.runs.get(runId)).toMatchObject({ trigger: "manual", jobId: null });
  });

  it("proposal-writer が success でも E-13 が増えていなければ skipped（理由は要約）", async () => {
    writeAgent("proposal-writer");
    writeAt(join(root, "wt"), `${PROPOSALS}/PRP-2026-0001.md`, proposalText());
    mocks.runAgent.mockResolvedValueOnce(ok("起票前チェック 3 で止めた"));
    const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "proposal-writer", prompt: "p" } });
    expect(await finished(runId)).toMatchObject({ outcome: "skipped", skipReason: "起票前チェック 3 で止めた" });
  });

  it("proposal-writer が E-13 を 1 件起票すれば success", async () => {
    writeAgent("proposal-writer");
    mocks.runAgent.mockImplementationOnce(async () => {
      writeAt(join(root, "wt"), `${PROPOSALS}/PRP-2026-0002.md`, proposalText({ id: "PRP-2026-0002" }));
      return ok("1 件起票した");
    });
    const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "proposal-writer", prompt: "p" } });
    expect((await finished(runId)).outcome).toBe("success");
  });
});

describe("Engine の結果の確定", () => {
  it("要約と見送りの理由を PII 検査に通してから記録する", async () => {
    mocks.handlers["silence-check"]!.mockResolvedValueOnce({
      outcome: "skipped",
      summary: "taro@example.com に連絡",
      skipReason: "090-1234-5678 が不明",
      targetIds: [],
    });
    const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
    expect(await finished(runId)).toMatchObject({
      summary: "[redacted:email] に連絡",
      summaryRedacted: true,
      skipReason: "[redacted:phone] が不明",
    });
  });

  it("summary が null ならそのまま null で、skipped 以外では skipReason を残さない", async () => {
    mocks.handlers["silence-check"]!.mockResolvedValueOnce({ outcome: "success", summary: null, targetIds: ["x"], skipReason: "無視" });
    const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
    expect(await finished(runId)).toMatchObject({ summary: null, summaryRedacted: false, skipReason: null, targetIds: ["x"] });
  });

  it("失敗の分類・SDK の subtype・費用を記録する", async () => {
    mocks.handlers["silence-check"]!.mockResolvedValueOnce({
      outcome: "partial",
      summary: "s",
      targetIds: [],
      failureClass: "truncated",
      sdkSubtype: "error_max_turns",
      costUsd: 1.25,
    });
    const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
    expect(await finished(runId)).toMatchObject({ failureClass: "truncated", sdkSubtype: "error_max_turns", costUsd: 1.25 });
  });

  it("実行中の例外は failure にし、エラー文（個人情報が混ざりうる）を E-15 に残さない", async () => {
    mocks.handlers["silence-check"]!.mockRejectedValueOnce(new Error("upstream said taro@example.com"));
    const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
    const record = await finished(runId);
    expect(record).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した", failureClass: null });
    expect(JSON.stringify(record)).not.toContain("taro@example.com");
    expect(ctx.leases.acquire("job:sample-job", "other", 1_000)).toBe(true);
  });
});

describe("Engine.stopAll", () => {
  it("実行中をすべて打ち切り、終了を待つ", async () => {
    mocks.handlers["silence-check"]!.mockImplementation(
      ({ signal }: BuiltinInput) =>
        new Promise<RunResult>((resolve) =>
          signal.addEventListener("abort", () => resolve({ outcome: "failure", summary: "中断", targetIds: [], failureClass: "timeout" })),
        ),
    );
    const a = await engine.start({ trigger: "schedule", job: makeJob({ id: "a" }) });
    const b = await engine.start({ trigger: "schedule", job: makeJob({ id: "b" }) });
    expect(engine.activeCount).toBe(2);
    await engine.stopAll();
    expect(engine.activeCount).toBe(0);
    expect(ctx.runs.get(a.runId)).toMatchObject({ outcome: "failure", failureClass: "timeout" });
    expect(ctx.runs.get(b.runId)!.status).toBe("finished");
  });

  it("実行中が無ければすぐ終わる", async () => {
    await expect(engine.stopAll()).resolves.toBeUndefined();
  });
});
