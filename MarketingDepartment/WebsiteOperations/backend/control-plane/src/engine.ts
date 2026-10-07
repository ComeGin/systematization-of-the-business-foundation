// 1 回の起動（定期実行・手動）を E-15 の 1 件として扱うエンジン。
//
// 起動の流れ:
//   1. 見送りの判定（after の未達・設定が無い・エージェント定義が無い・前回が実行中）→ skipped を記録して返す
//   2. 相関 ID（ULID）を起動の直前に発行し、running の行を先に E-15 に書く
//   3. エージェントまたは builtin を実行（手動の起動は完了を待たずに返す）
//   4. 結果を PII 検査にかけて E-15 に確定し、リースを返し、S3 への写しを試みる
// E-15 に書くのはこのエンジン（監視アプリのサーバー側）だけ。実行側（エージェント）には書かせない。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_HANDLERS, missingConfigFor } from "./builtin/index.js";
import type { EngineContext, RunResult } from "./context.js";
import { PROPOSALS_DIR } from "./constants/paths.js";
import { MANUAL_AGENT_DEFAULTS } from "./constants/timeouts.js";
import type { BuiltinJob, ManualRunAccepted, RunTrigger } from "./contract.js";
import { AgentDefinitionError, loadAgentDefinition } from "./definitions/agent-def.js";
import type { ScheduleDefinition } from "./definitions/schedules.js";
import { logLine } from "./log.js";
import { redactSummary } from "./pii.js";
import { runAgent } from "./runner/agent.js";
import { jstDayStart, toIsoJst } from "./time.js";
import { ulid } from "./ulid.js";

/** リースの余裕。リース時間 = timeout_sec + この値（実行中の印が先に切れて二重起動しないため） */
const LEASE_GRACE_MS = 60_000;
/** stop() が実行中の終了を待つ上限 */
const STOP_WAIT_MS = 10_000;

export interface StartRequest {
  trigger: RunTrigger;
  /** 定期実行の定義から起動する */
  job?: ScheduleDefinition;
  /** 手動の指示でエージェントを起動する */
  adHoc?: { agent: string; prompt: string };
}

interface Prepared {
  jobId: string | null;
  agentName: string | null;
  builtin: BuiltinJob | null;
  leaseKey: string;
  timeoutSec: number;
  execute: (runId: string, signal: AbortSignal, startedAt: string) => Promise<RunResult>;
}

export class Engine {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(private readonly ctx: EngineContext) {}

  /** 起動する。見送ったときは skipped の記録を作り accepted=false で返す。実行の完了は待たない。 */
  async start(request: StartRequest): Promise<ManualRunAccepted> {
    const runId = ulid();
    const startedAt = toIsoJst();

    let prepared: Prepared | { skip: string };
    try {
      prepared = await this.prepare(request);
    } catch (error) {
      logLine("ERROR", "engine", `起動の準備に失敗: ${error instanceof Error ? error.message : "不明"}`, runId);
      prepared = { skip: "起動の準備に失敗したため見送った" };
    }

    const identity = this.identityOf(request);
    if ("skip" in prepared) return this.recordSkipped(runId, startedAt, request, identity, prepared.skip);

    const leased = this.ctx.leases.acquire(prepared.leaseKey, runId, prepared.timeoutSec * 1000 + LEASE_GRACE_MS);
    if (!leased) {
      return this.recordSkipped(runId, startedAt, request, identity, "前回の実行が継続中のため起動を見送った");
    }

    try {
      this.ctx.runs.insertRunning({
        runId,
        jobId: prepared.jobId,
        agentName: prepared.agentName,
        builtin: prepared.builtin,
        trigger: request.trigger,
        startedAt,
      });
    } catch (error) {
      // 記録できないまま実行はしない。リースを返さないと、リース時間の間同じ定義の起動がすべて見送られる
      this.ctx.leases.release(prepared.leaseKey, runId);
      throw error;
    }
    logLine("INFO", "engine", `起動 job=${prepared.jobId ?? "-"} agent=${prepared.agentName ?? "-"} builtin=${prepared.builtin ?? "-"}`, runId);

    const controller = new AbortController();
    // done を reject させない。監視アプリと 1 プロセスで動くため、未処理の reject はプロセスごと落とす
    const done = this.run(runId, startedAt, prepared, controller)
      .catch((error: unknown) =>
        logLine("ERROR", "engine", `実行の後始末に失敗: ${error instanceof Error ? error.message : "不明"}`, runId),
      )
      .finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, done });
    return { runId, accepted: true };
  }

  /** 実行中をすべて打ち切り、終了を待つ。未送の写しは E-15 に残る。 */
  async stopAll(): Promise<void> {
    for (const { controller } of this.active.values()) controller.abort();
    const pending = [...this.active.values()].map((entry) => entry.done);
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())]);
  }

  get activeCount(): number {
    return this.active.size;
  }

  private identityOf(request: StartRequest) {
    return {
      jobId: request.job?.id ?? null,
      agentName: request.job?.agent ?? request.adHoc?.agent ?? null,
      builtin: request.job?.builtin ?? null,
    };
  }

  /** 見送りの判定と、実行の組み立て。 */
  private async prepare(request: StartRequest): Promise<Prepared | { skip: string }> {
    const { config } = this.ctx;
    const job = request.job;

    // after: 先に終わっている必要があるジョブが、当日（日本時間）に success で終わっていなければ見送る。
    // 手動の起動は人の判断なので対象外。
    if (job && request.trigger === "schedule" && job.after.length > 0) {
      const dayStart = toIsoJst(jstDayStart());
      const unmet = job.after.filter((id) => !this.ctx.runs.hasSuccessSince(id, dayStart));
      if (unmet.length > 0) return { skip: `after が未達（当日に success が無い: ${unmet.join(", ")}）` };
    }

    if (job?.kind === "builtin" || (job === undefined && !request.adHoc)) {
      const builtin = job?.builtin;
      if (!builtin) return { skip: "builtin の指定が無い" };
      const missing = missingConfigFor(builtin, config);
      if (missing.length > 0) return { skip: `設定が無いため見送った（${missing.join(", ")}）` };
      const timeoutSec = job?.timeoutSec ?? MANUAL_AGENT_DEFAULTS.timeoutSec;
      return {
        jobId: job?.id ?? null,
        agentName: null,
        builtin,
        leaseKey: job ? `job:${job.id}` : `builtin:${builtin}`,
        timeoutSec,
        execute: (runId, signal) =>
          BUILTIN_HANDLERS[builtin]({ ctx: this.ctx, runId, signal, timeoutSec, job: job ?? null }),
      };
    }

    // エージェント
    const agent = job?.agent ?? request.adHoc?.agent;
    const prompt = job?.prompt ?? request.adHoc?.prompt;
    if (!agent || !prompt?.trim()) return { skip: "エージェント名またはプロンプトが無い" };
    if (!config.anthropic) return { skip: "設定が無いため見送った（ANTHROPIC_API_KEY）" };
    let definition;
    try {
      definition = await loadAgentDefinition(config.mainCheckout, agent);
    } catch (error) {
      if (error instanceof AgentDefinitionError) return { skip: error.message };
      throw error;
    }
    const timeoutSec = job?.timeoutSec ?? MANUAL_AGENT_DEFAULTS.timeoutSec;
    const maxTurns = job?.maxTurns ?? MANUAL_AGENT_DEFAULTS.maxTurns;
    return {
      jobId: job?.id ?? null,
      agentName: agent,
      builtin: null,
      leaseKey: job ? `job:${job.id}` : `agent:${agent}`,
      timeoutSec,
      execute: async (runId, signal, startedAt) => {
        const proposalsBefore = agent === "proposal-writer" ? await this.countProposals() : 0;
        const result = await runAgent({ ctx: this.ctx, runId, startedAt, definition, prompt, timeoutSec, maxTurns, signal });
        // 起票前チェックで止めた事実を skipped として残す（DD-06 の 1.2）。
        // 判定は決定論的に行う: proposal-writer が success で終わったのに E-13 が 1 件も増えていない。
        if (agent === "proposal-writer" && result.outcome === "success" && (await this.countProposals()) <= proposalsBefore) {
          return { ...result, outcome: "skipped", skipReason: result.summary };
        }
        return result;
      },
    };
  }

  private async countProposals(): Promise<number> {
    try {
      return (await readdir(join(this.ctx.config.worktree, PROPOSALS_DIR))).filter((name) => /^PRP-\d{4}-\d{4}\.md$/.test(name)).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private recordSkipped(
    runId: string,
    startedAt: string,
    request: StartRequest,
    identity: { jobId: string | null; agentName: string | null; builtin: BuiltinJob | null },
    reason: string,
  ): ManualRunAccepted {
    this.ctx.runs.insertRunning({ runId, ...identity, trigger: request.trigger, startedAt });
    const summary = redactSummary(reason);
    this.ctx.runs.finish(runId, {
      finishedAt: toIsoJst(),
      outcome: "skipped",
      summary: summary.text,
      summaryRedacted: summary.redacted,
      targetIds: [],
      skipReason: summary.text,
      failureClass: null,
      sdkSubtype: null,
      costUsd: null,
    });
    logLine("INFO", "engine", `見送り: ${summary.text}`, runId);
    void this.copyBestEffort();
    return { runId, accepted: false };
  }

  private async run(runId: string, startedAt: string, prepared: Prepared, controller: AbortController): Promise<void> {
    let result: RunResult;
    try {
      result = await prepared.execute(runId, controller.signal, startedAt);
    } catch (error) {
      // 内部エラーの詳細は stderr だけに出し、E-15 には残さない（上流のエラー文に個人情報が混ざりうる）
      logLine("ERROR", "engine", `実行中に内部エラー: ${error instanceof Error ? error.message : "不明"}`, runId);
      result = { outcome: "failure", summary: "実行中に内部エラーが発生した", targetIds: [], failureClass: null };
    }
    try {
      const summary = redactSummary(result.summary ?? "");
      this.ctx.runs.finish(runId, {
        finishedAt: toIsoJst(),
        outcome: result.outcome,
        summary: result.summary === null ? null : summary.text,
        summaryRedacted: summary.redacted,
        targetIds: result.targetIds,
        skipReason: result.outcome === "skipped" ? redactSummary(result.skipReason ?? result.summary ?? "").text : null,
        failureClass: result.failureClass ?? null,
        sdkSubtype: result.sdkSubtype ?? null,
        costUsd: result.costUsd ?? null,
      });
      logLine("INFO", "engine", `終了 outcome=${result.outcome} class=${result.failureClass ?? "-"}`, runId);
    } catch (error) {
      // 確定できなかった run は running のまま残り、次のプロセスの起動時（interruptStaleRuns）に中断として確定する。
      // 例外の本文は SQLite のもの（束縛した値は含まない）。summary などの中身はログに出さない
      logLine(
        "ERROR",
        "engine",
        `結果の確定に失敗（running のまま残る） outcome=${result.outcome}: ${error instanceof Error ? error.message : "不明"}`,
        runId,
      );
    } finally {
      this.ctx.leases.release(prepared.leaseKey, runId);
    }
    await this.copyBestEffort();
  }

  /** 各実行の終了時の写し。失敗しても E-15 に未送として残り、後で再送される。 */
  private async copyBestEffort(): Promise<void> {
    try {
      await this.ctx.copier?.flush();
    } catch (error) {
      logLine("WARN", "engine", `写しの試行に失敗: ${error instanceof Error ? error.name : "不明"}`);
    }
  }
}
