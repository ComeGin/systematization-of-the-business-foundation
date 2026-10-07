// エージェントの起動（runner/agent の runAgent）と builtin の実行（BUILTIN_HANDLERS）は vi.mock で差し替え、
// Agent SDK・GitHub・AWS・Chatwoot には繋がない。E-15 は makeCtx の :memory: の SQLite（基準 D の例外: 記録の中身を確かめるのが本質）。
// エージェント定義と E-13 の数え上げは、エンジン自身のファイル操作なので os.tmpdir() の下の一時ディレクトリで確かめる。
import { mkdirSync, writeFileSync } from "node:fs";
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
const BUILTINS: BuiltinJob[] = [
  "heartbeat",
  "i13-file",
  "miswrite-check",
  "silence-check",
  "lighthouse",
  "published-article-check",
  "runlog-flush",
  "n8n-export",
];

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

const logged = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");

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
  describe("正常系", () => {
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

    it("終了時と見送り時に S3 への写しを試みる", async () => {
      const flush = vi.fn(async () => ({ sent: 1, alreadyCopied: 0, remaining: 0, failureClass: null }));
      ctx.copier = { flush } as unknown as RunLogCopier;
      const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
      await finished(runId);
      await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
      await engine.start({ trigger: "schedule", job: makeJob({ builtin: "i13-file" }) });
      await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
    });

    it("空入力: AWS が無効（copier が null）なら写しを試みずに終わる", async () => {
      ctx.copier = null;
      const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
      expect((await finished(runId)).outcome).toBe("success");
    });
  });

  describe("異常系", () => {
    it("サーバ: S3 への写しの失敗は実行の記録に影響せず、ログには例外の名前だけを出す", async () => {
      const flush = vi.fn(async () => {
        throw new Error("S3 down: AKIASECRETKEYVALUE");
      });
      ctx.copier = { flush } as unknown as RunLogCopier;
      const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
      expect((await finished(runId)).outcome).toBe("success");
      await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
      await engine.start({ trigger: "schedule", job: makeJob({ builtin: "i13-file" }) });
      await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(logged()).toContain("写しの試行に失敗: Error"));
      expect(logged()).not.toContain("AKIASECRETKEYVALUE");
    });

    it("サーバ: running の記録（insertRunning）が DB の例外で失敗したら、start は reject して実行しない", async () => {
      vi.spyOn(ctx.runs, "insertRunning").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      await expect(engine.start({ trigger: "schedule", job: makeJob() })).rejects.toThrow("database is locked");
      expect(mocks.handlers["silence-check"]).not.toHaveBeenCalled();
      expect(engine.activeCount).toBe(0);
    });

    // insertRunning が投げたら、取ったリースを返してから投げ直す（返さないと timeout_sec + 60 秒の間、同じ定義が見送られる）
    it("サーバ: running の記録が DB の例外で失敗したら、取ったリースを返し、次の起動を見送らない", async () => {
      vi.spyOn(ctx.runs, "insertRunning").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });
      await expect(engine.start({ trigger: "schedule", job: makeJob() })).rejects.toThrow("database is locked");
      const next = await engine.start({ trigger: "schedule", job: makeJob() });
      expect(next.accepted).toBe(true);
      expect((await finished(next.runId)).outcome).toBe("success");
    });

    // finish が投げても done は reject しない（監視アプリと 1 プロセスのため、未処理の reject はプロセスごと落とす）
    it("サーバ: 結果の確定が DB の例外で失敗しても unhandled rejection にせず、ログに残してリースを返す", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        vi.spyOn(ctx.runs, "finish").mockImplementationOnce(() => {
          throw new Error("database is locked");
        });
        mocks.handlers["silence-check"]!.mockResolvedValueOnce(ok("秘密の要約 sk-ant-SHOULD-NOT-LEAK"));
        const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
        await vi.waitFor(() => expect(engine.activeCount).toBe(0));
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).not.toHaveBeenCalled();
        expect(ctx.runs.get(runId)?.status).toBe("running");
        expect(logged()).toContain("結果の確定に失敗（running のまま残る） outcome=success: database is locked");
        expect(logged()).not.toContain("sk-ant-SHOULD-NOT-LEAK");
        // リースは返っているので、同じ定義を再び起動できる
        expect((await engine.start({ trigger: "schedule", job: makeJob() })).accepted).toBe(true);
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("サーバ: 後始末（リースの返却）が投げても unhandled rejection にせず、ログに残す", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        vi.spyOn(ctx.leases, "release").mockImplementationOnce(() => {
          throw new Error("disk I/O error");
        });
        const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
        await vi.waitFor(() => expect(engine.activeCount).toBe(0));
        await new Promise((resolve) => setImmediate(resolve));

        expect(unhandled).not.toHaveBeenCalled();
        expect(ctx.runs.get(runId)?.status).toBe("finished");
        expect(logged()).toContain("実行の後始末に失敗: disk I/O error");
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });
});

describe("Engine.start の多重起動防止", () => {
  describe("正常系", () => {
    it("前回が終われば、同じ定義を再び起動できる", async () => {
      const first = await engine.start({ trigger: "schedule", job: makeJob() });
      await finished(first.runId);
      await vi.waitFor(() => expect(engine.activeCount).toBe(0));
      expect((await engine.start({ trigger: "schedule", job: makeJob() })).accepted).toBe(true);
    });

    it("別の定義は同時に起動できる", async () => {
      const gate = deferred<RunResult>();
      mocks.handlers["silence-check"]!.mockReturnValue(gate.promise);
      await engine.start({ trigger: "schedule", job: makeJob({ id: "a" }) });
      expect((await engine.start({ trigger: "schedule", job: makeJob({ id: "b" }) })).accepted).toBe(true);
      gate.resolve(ok());
    });
  });

  describe("異常系", () => {
    it("入力: 前回が実行中なら起動を見送り、skipped を記録して accepted=false を返す", async () => {
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

    it("入力: 手動で定義を起動しても、同じ定義の定期実行と同じ印を使う", async () => {
      const gate = deferred<RunResult>();
      mocks.handlers["silence-check"]!.mockReturnValueOnce(gate.promise);
      await engine.start({ trigger: "schedule", job: makeJob() });
      expect((await engine.start({ trigger: "manual", job: makeJob() })).accepted).toBe(false);
      gate.resolve(ok());
    });

    it("入力: 手動のエージェント起動は同じエージェント名で重ねない", async () => {
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

  describe("正常系", () => {
    it("after のジョブが当日（日本時間）に success なら起動する", async () => {
      dependencyRun("2026-10-05T00:00:00.000+09:00", "success");
      expect((await engine.start({ trigger: "schedule", job: makeJob({ after: ["dep"] }) })).accepted).toBe(true);
    });

    it("手動の起動は after を見ない（人の判断）", async () => {
      expect((await engine.start({ trigger: "manual", job: makeJob({ after: ["dep"] }) })).accepted).toBe(true);
    });

    it("空入力: after が空配列なら判定せずに起動する", async () => {
      const hasSuccessSince = vi.spyOn(ctx.runs, "hasSuccessSince");
      expect((await engine.start({ trigger: "schedule", job: makeJob({ after: [] }) })).accepted).toBe(true);
      expect(hasSuccessSince).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("入力: after のジョブが当日に success で終わっていなければ見送る", async () => {
      dependencyRun("2026-10-05T06:00:00.000+09:00", "failure");
      dependencyRun("2026-10-04T06:00:00.000+09:00", "success");
      const result = await engine.start({ trigger: "schedule", job: makeJob({ after: ["dep"] }) });
      expect(result.accepted).toBe(false);
      expect(ctx.runs.get(result.runId)!.skipReason).toBe("after が未達（当日に success が無い: dep）");
      expect(mocks.handlers["silence-check"]).not.toHaveBeenCalled();
    });

    it("空入力: builtin に必要な設定が無ければ、変数名だけを理由にして見送る", async () => {
      const result = await engine.start({ trigger: "schedule", job: makeJob({ builtin: "i13-file" }) });
      expect(result.accepted).toBe(false);
      expect(ctx.runs.get(result.runId)!.skipReason).toBe(
        "設定が無いため見送った（GITHUB_TOKEN, GITHUB_REPOSITORY, I13_ISSUE_NUMBER, I13_REVIEWER）",
      );
      expect(mocks.handlers["i13-file"]).not.toHaveBeenCalled();
    });

    it("空入力: n8n-export に必要な設定（n8n と GitHub）が無ければ、6 つの変数名を理由にして見送る", async () => {
      const result = await engine.start({ trigger: "schedule", job: makeJob({ builtin: "n8n-export" }) });
      expect(result.accepted).toBe(false);
      expect(ctx.runs.get(result.runId)!.skipReason).toBe(
        "設定が無いため見送った（CONTROL_N8N_EXPORT_URL, CONTROL_N8N_EXPORT_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY, I13_ISSUE_NUMBER, I13_REVIEWER）",
      );
      expect(mocks.handlers["n8n-export"]).not.toHaveBeenCalled();
    });

    it("空入力: builtin の指定が無い定義・定義もエージェントも無い依頼は見送る", async () => {
      const noBuiltin = await engine.start({ trigger: "schedule", job: makeJob({ builtin: null }) });
      expect(ctx.runs.get(noBuiltin.runId)!.skipReason).toBe("builtin の指定が無い");
      const empty = await engine.start({ trigger: "manual" });
      expect(ctx.runs.get(empty.runId)).toMatchObject({ outcome: "skipped", skipReason: "builtin の指定が無い" });
    });

    it("空入力: ANTHROPIC_API_KEY が無ければエージェントを見送る", async () => {
      ctx.config.anthropic = null;
      const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
      expect(ctx.runs.get(result.runId)!.skipReason).toBe("設定が無いため見送った（ANTHROPIC_API_KEY）");
      expect(mocks.runAgent).not.toHaveBeenCalled();
    });

    it("入力: エージェント定義が main に無ければ見送る", async () => {
      const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
      expect(ctx.runs.get(result.runId)!.skipReason).toBe("エージェント定義が見つからない: seo-auditor");
    });

    it("空入力: プロンプトが空白だけなら見送る", async () => {
      writeAgent("seo-auditor");
      const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "   " } });
      expect(ctx.runs.get(result.runId)!.skipReason).toBe("エージェント名またはプロンプトが無い");
    });

    it("空入力: エージェント名が空文字なら見送る", async () => {
      const result = await engine.start({ trigger: "manual", adHoc: { agent: "", prompt: "p" } });
      expect(ctx.runs.get(result.runId)).toMatchObject({ outcome: "skipped", skipReason: "エージェント名またはプロンプトが無い" });
      expect(mocks.runAgent).not.toHaveBeenCalled();
    });

    it("空入力: エージェントの定義に prompt が無ければ見送る", async () => {
      writeAgent("seo-auditor");
      const job = makeJob({ kind: "agent", agent: "seo-auditor", builtin: null, prompt: null });
      const result = await engine.start({ trigger: "schedule", job });
      expect(ctx.runs.get(result.runId)).toMatchObject({ skipReason: "エージェント名またはプロンプトが無い", jobId: job.id });
    });

    it("サーバ: 準備中の想定外の例外は、詳細を記録せず見送りにする", async () => {
      mkdirSync(join(root, "main/.claude/agents/seo-auditor.md"), { recursive: true }); // 読むと EISDIR
      const result = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
      const record = ctx.runs.get(result.runId)!;
      expect(record).toMatchObject({ outcome: "skipped", skipReason: "起動の準備に失敗したため見送った" });
      expect(JSON.stringify(record)).not.toContain("EISDIR");
    });
  });
});

describe("Engine.start のエージェントの起動", () => {
  describe("正常系", () => {
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

    it("空入力: proposals のディレクトリが無く、増えもしなければ skipped（0 件から 0 件）", async () => {
      writeAgent("proposal-writer");
      mocks.runAgent.mockResolvedValueOnce(ok("根拠が足りない"));
      const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "proposal-writer", prompt: "p" } });
      expect(await finished(runId)).toMatchObject({ outcome: "skipped", skipReason: "根拠が足りない" });
    });
  });

  describe("異常系", () => {
    it("入力: E-13 の命名（PRP-<西暦>-<4 桁>.md）に合わないファイルは件数に数えない", async () => {
      writeAgent("proposal-writer");
      mocks.runAgent.mockImplementationOnce(async () => {
        writeAt(join(root, "wt"), `${PROPOSALS}/draft.md`, "x");
        writeAt(join(root, "wt"), `${PROPOSALS}/PRP-2026-1.md`, "x");
        return ok("起票した");
      });
      const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "proposal-writer", prompt: "p" } });
      expect((await finished(runId)).outcome).toBe("skipped");
    });

    it("サーバ: proposals の場所を読めなければ（ENOTDIR）、詳細を残さず failure にする", async () => {
      writeAgent("proposal-writer");
      mkdirSync(join(root, "wt/MarketingDepartment/WebsiteOperations/docs"), { recursive: true });
      writeFileSync(join(root, "wt", PROPOSALS), "not a directory");
      const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "proposal-writer", prompt: "p" } });
      const record = await finished(runId);
      expect(record).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した" });
      expect(JSON.stringify(record)).not.toContain("ENOTDIR");
      expect(mocks.runAgent).not.toHaveBeenCalled();
    });

    it("サーバ: runAgent が例外を投げたら failure にし、リースを返す", async () => {
      writeAgent("seo-auditor");
      mocks.runAgent.mockRejectedValueOnce(new Error("mcp-registry.yaml が不正です"));
      const { runId } = await engine.start({ trigger: "manual", adHoc: { agent: "seo-auditor", prompt: "p" } });
      expect(await finished(runId)).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した" });
      expect(ctx.leases.acquire("agent:seo-auditor", "other", 1_000)).toBe(true);
    });
  });
});

describe("Engine の結果の確定", () => {
  describe("正常系", () => {
    it("空入力: summary が null ならそのまま null で、skipped 以外では skipReason を残さない", async () => {
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

    it("空入力: skipped で skipReason が無ければ要約を理由にし、どちらも無ければ空文字", async () => {
      mocks.handlers["silence-check"]!.mockResolvedValueOnce({ outcome: "skipped", summary: "対象なし", targetIds: [] });
      const first = await engine.start({ trigger: "schedule", job: makeJob({ id: "a" }) });
      expect(await finished(first.runId)).toMatchObject({ skipReason: "対象なし" });
      mocks.handlers["silence-check"]!.mockResolvedValueOnce({ outcome: "skipped", summary: null, targetIds: [] });
      const second = await engine.start({ trigger: "schedule", job: makeJob({ id: "b" }) });
      expect(await finished(second.runId)).toMatchObject({ summary: null, skipReason: "" });
    });
  });

  describe("異常系", () => {
    it("入力: 要約と見送りの理由に PII があれば伏せてから記録する", async () => {
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

    it("サーバ: 実行中の例外は failure にし、エラー文（個人情報が混ざりうる）を E-15 に残さない", async () => {
      mocks.handlers["silence-check"]!.mockRejectedValueOnce(new Error("upstream said taro@example.com"));
      const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
      const record = await finished(runId);
      expect(record).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した", failureClass: null });
      expect(JSON.stringify(record)).not.toContain("taro@example.com");
      expect(ctx.leases.acquire("job:sample-job", "other", 1_000)).toBe(true);
    });

    it("サーバ: Error でない値で reject されても failure にする", async () => {
      mocks.handlers["silence-check"]!.mockRejectedValueOnce("string rejection");
      const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
      expect(await finished(runId)).toMatchObject({ outcome: "failure", summary: "実行中に内部エラーが発生した" });
      expect(logged()).toContain("実行中に内部エラー: 不明");
    });
  });
});

describe("Engine.stopAll", () => {
  describe("正常系", () => {
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

    it("空入力: 実行中が無ければすぐ終わる", async () => {
      await expect(engine.stopAll()).resolves.toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("サーバ: 打ち切りに応じない実行は 10 秒で待つのをやめ、running のまま残す（次の起動時に中断として確定する）", async () => {
      const gate = deferred<RunResult>();
      mocks.handlers["silence-check"]!.mockReturnValue(gate.promise);
      const { runId } = await engine.start({ trigger: "schedule", job: makeJob() });
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const stopping = engine.stopAll();
      await vi.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void stopping.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(stopping).resolves.toBeUndefined();
      expect(ctx.runs.get(runId)!.status).toBe("running");
      vi.useRealTimers();
      gate.resolve(ok());
      await finished(runId);
    });
  });
});
