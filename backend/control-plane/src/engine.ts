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
import { PROPOSALS_DIR, VERDANT_VIRGO_DIR } from "./constants/paths.js";
import { MANUAL_AGENT_DEFAULTS } from "./constants/timeouts.js";
import type { BuiltinJob, ManualRunAccepted, ProposalKind, RunTrigger } from "./contract.js";
import { shellQuote } from "./cycle/commands.js";
import { runGit } from "./cycle/git.js";
import { AgentDefinitionError, loadAgentDefinition } from "./definitions/agent-def.js";
import type { Proposal } from "./definitions/proposal.js";
import type { ScheduleDefinition } from "./definitions/schedules.js";
import { logLine } from "./log.js";
import { redactSummary } from "./pii.js";
import { runAgent } from "./runner/agent.js";
import { cycleOf } from "./cycle/calendar.js";
import { itemShapeOf, listApprovedProposals, pickNextProposal } from "./cycle/proposals.js";
import { jstDayStart, toIsoJst } from "./time.js";
import { ulid } from "./ulid.js";

/** リースの余裕。リース時間 = timeout_sec + この値（実行中の印が先に切れて二重起動しないため） */
const LEASE_GRACE_MS = 60_000;
/** 項目の題・要約に使う、E-13 の change.description の先頭の文字数 */
const ITEM_TITLE_MAX = 100;
/** stop() が実行中の終了を待つ上限 */
const STOP_WAIT_MS = 10_000;
/** 作業場の git status の打ち切り */
const GIT_STATUS_TIMEOUT_MS = 30_000;
/** code の項目を作る E-13 の種類（proposals.ts の itemShapeOf で code になるもの） */
const CODE_PROPOSAL_KINDS: readonly ProposalKind[] = ["technical_seo", "accessibility", "cta_swap", "internal_link"];

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
  /** E-15 に残す起動の種類。承認済みの E-13 を渡して起動したときだけ "proposal"（無ければ request.trigger） */
  trigger?: RunTrigger;
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
        trigger: prepared.trigger ?? request.trigger,
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

    // cycle_days: 周の何日目に動かすか。手動の起動は人の判断なので対象外
    if (job && request.trigger === "schedule" && job.cycleDays) {
      if (!config.cycleAnchor) return { skip: "CONTROL_CYCLE_ANCHOR が無いため見送った" };
      const { day } = cycleOf(new Date(), config.cycleAnchor);
      if (!job.cycleDays.includes(day)) return { skip: `周の ${day} 日目は対象外` };
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

    // proposal_kinds: 作用のジョブ。承認済みで、まだ項目が無い E-13 を 1 件だけ選んで渡す（選ぶのはエージェントではなくここ）
    let picked: Proposal | null = null;
    if (job?.proposalKinds) {
      // 起点が無いと項目を作れず、同じ E-13 が毎回選ばれる（I3）。手動の起動でも見送る
      if (!config.cycleAnchor) return { skip: "CONTROL_CYCLE_ANCHOR が無いため見送った" };
      // コードの種類を扱うジョブ（cycle-apply-code）は、作業場の公開サイトのソースに未コミットの差分があれば見送る（spec 5.2。I1）。
      // 前の差分の上に次の E-13 の差分を重ねると、code の項目のファイルと PR がずれる
      if (job.proposalKinds.some((kind) => CODE_PROPOSAL_KINDS.includes(kind))) {
        const status = await runGit(config.worktree, ["status", "--porcelain", "--", `${VERDANT_VIRGO_DIR}/src`], { timeoutMs: GIT_STATUS_TIMEOUT_MS });
        if (!status.ok) return { skip: `作業場の git status を読めなかったため見送った（${VERDANT_VIRGO_DIR}/src の未コミットの差分を確かめられない）` };
        if (status.stdout.trim() !== "") {
          return {
            skip:
              `作業場の ${VERDANT_VIRGO_DIR}/src に未コミットの差分がある。人がコミットするか、code の項目を差し戻して作業場の差分を捨ててから` +
              `（git -C ${shellQuote(config.worktree)} restore --source=HEAD --staged --worktree -- ${VERDANT_VIRGO_DIR}/src と、未追跡のファイルの削除）、次の E-13 に進む`,
          };
        }
      }
      const proposals = await listApprovedProposals(config.mainCheckout);
      picked = pickNextProposal(proposals, job.proposalKinds, this.ctx.cycles.listProposalIdsWithItems());
      if (!picked) return { skip: "承認済みで未着手の E-13 が無い" };
    }

    return {
      jobId: job?.id ?? null,
      agentName: agent,
      builtin: null,
      trigger: picked ? "proposal" : undefined,
      leaseKey: job ? `job:${job.id}` : `agent:${agent}`,
      timeoutSec,
      execute: async (runId, signal, startedAt) => {
        if (picked) this.openPreparingItem(picked, runId);
        const proposalsBefore = agent === "proposal-writer" ? await this.countProposals() : 0;
        const withProposal = picked ? `${prompt}\n\nPRP: ${picked.proposal_id}` : prompt;
        // 公開サイトのベース URL（メールのリンクなどに使う）。設定があるときだけ、末尾の / を除いて全エージェントに渡す
        const siteUrl = config.siteUrl?.replace(/\/+$/, "");
        const agentPrompt = siteUrl ? `${withProposal}\n\nSITE_URL: ${siteUrl}` : withProposal;
        const result = await runAgent({ ctx: this.ctx, runId, startedAt, definition, prompt: agentPrompt, timeoutSec, maxTurns, signal });
        // 起票前チェックで止めた事実を skipped として残す（DD-06 の 1.2）。
        // 判定は決定論的に行う: proposal-writer が success で終わったのに E-13 が 1 件も増えていない。
        if (agent === "proposal-writer" && result.outcome === "success" && (await this.countProposals()) <= proposalsBefore) {
          return { ...result, outcome: "skipped", skipReason: result.summary };
        }
        return result;
      },
    };
  }

  /**
   * 作用のジョブの起動時に、準備中（preparing）の項目を作る。中身は作用のジョブが完成させる。
   * 起点（CONTROL_CYCLE_ANCHOR）が無いときは prepare で見送るので、ここには来ない（念のため作らずに返す）。作れなくても起動は止めない。
   * 画面に出す文字なので、要約と同じ PII 検査を通す。
   */
  private openPreparingItem(proposal: Proposal, runId: string): void {
    const { config, cycles } = this.ctx;
    const shape = itemShapeOf(proposal.change.kind);
    if (!shape) return;
    if (!config.cycleAnchor) {
      logLine("WARN", "engine", "CONTROL_CYCLE_ANCHOR が無いため、項目を作らずに起動する", runId);
      return;
    }
    try {
      const text = redactSummary(Array.from(proposal.change.description).slice(0, ITEM_TITLE_MAX).join("")).text;
      cycles.upsertItem({
        cycleId: cycleOf(new Date(), config.cycleAnchor).cycleId,
        kind: shape.kind,
        stage: shape.stage,
        sourceRef: proposal.proposal_id,
        proposalId: proposal.proposal_id,
        title: text,
        summary: text,
        evidence: proposal.evidence.map((e) => ({ auditId: e.audit_id, summary: redactSummary(e.summary).text })),
        preview: { kind: "pending" },
      });
    } catch (error) {
      logLine("WARN", "engine", `項目を作れなかった: ${error instanceof Error ? error.name : "不明"}`, runId);
    }
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
    // 停止要求（stop()）で打ち切った run は failure（timeout）に確定する（契約の stop）。打ち切りで途中までしか見ていない builtin
    // （例: miswrite-check は会話を 1 件も読まずに抜ける）が success を返しても、それを成功として残さない
    if (controller.signal.aborted && (result.outcome === "success" || result.outcome === "partial")) {
      result = { ...result, outcome: "failure", summary: "停止要求で中断した", failureClass: "timeout" };
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
        model: result.model ?? null,
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
