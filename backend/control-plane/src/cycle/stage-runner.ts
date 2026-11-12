// 改善ループの段階（①〜⑦）ごとの「今すぐ実行」（2026-11-12）。
// 段階のジョブを、決めた順に 1 本ずつ手動で起動し、前のジョブが終わってから次を起動する（同時に起動すると、初稿の前にアイキャッチが走る
// など順番が崩れるため）。順は orderStageJobs（after の依存 → 段階ごとに明示した順〈cycle/service.ts の STAGE_ORDER〉→ 定期実行の時刻
// 〈その日の何分目〉→ id）。定期実行の時刻は日をまたいで追いつく前提で決めてあるので、1 回で通す順と合わない段階（③）だけ明示する。
// 手動の起動なので、各ジョブの after・cycle_days・enabled は見ない（engine.prepare と同じ）。同じジョブが実行中なら、そのジョブは
// 見送り（skipped の記録）になり、次へ進む。進み具合はプロセスのメモリにだけ持つ（監視アプリを起動し直すと、残りは起動されない）。
import type { EngineContext } from "../context.js";
import type { CycleStage, CycleStageRun, JobDefinition, ManualRunAccepted, Ulid } from "../contract.js";
import { logLine } from "../log.js";
import { toIsoJst } from "../time.js";

/** 終わったかを見る間隔 */
const POLL_MS = 3_000;
/** ジョブの打ち切り（timeout_sec）に足す、待つ時間の余裕 */
const WAIT_GRACE_MS = 2 * 60 * 1000;

/** cron の分と時が数字だけなら、その日の何分目か。それ以外（15 分ごとなどの書き方）は先頭に置く */
function minuteOfDay(cron: string): number {
  const [minute, hour] = cron.trim().split(/\s+/);
  const m = Number(minute);
  const h = Number(hour);
  return Number.isInteger(m) && Number.isInteger(h) ? h * 60 + m : -1;
}

/**
 * 段階の中の実行の順。after の依存を守り（段階の中のジョブどうしだけ）、そのうえで preferred（明示した順）・定期実行の時刻・id の順。
 * preferred に無いジョブは、preferred にあるものの後ろに並ぶ
 */
export function orderStageJobs<T extends Pick<JobDefinition, "id" | "cron" | "after">>(jobs: readonly T[], preferred: readonly string[] = []): T[] {
  const rank = (job: T) => {
    const index = preferred.indexOf(job.id);
    return index === -1 ? preferred.length : index;
  };
  const byKey = (a: T, b: T) => rank(a) - rank(b) || minuteOfDay(a.cron) - minuteOfDay(b.cron) || a.id.localeCompare(b.id);
  const ids = new Set(jobs.map((job) => job.id));
  const pending = [...jobs].sort(byKey);
  const done = new Set<string>();
  const ordered: T[] = [];
  while (pending.length > 0) {
    // 依存がすべて済んだもののうち、最も早いもの。循環していたら残りを時刻の順のまま並べる
    const index = pending.findIndex((job) => job.after.every((dep) => !ids.has(dep) || done.has(dep)));
    const [next] = pending.splice(index === -1 ? 0 : index, 1);
    ordered.push(next!);
    done.add(next!.id);
  }
  return ordered;
}

export interface StageEngine {
  start(request: { trigger: "manual"; job: JobDefinition }): Promise<ManualRunAccepted>;
}

export class StageRunner {
  private readonly runs = new Map<CycleStage, CycleStageRun>();
  private readonly controller = new AbortController();

  constructor(
    private readonly ctx: EngineContext,
    private readonly engine: StageEngine,
  ) {}

  /** 段階の直近の実行（終わったものも、次に起動するまで残す）。無ければ null */
  state(stage: CycleStage): CycleStageRun | null {
    const run = this.runs.get(stage);
    return run ? structuredClone(run) : null;
  }

  /** 起動する（完了は待たない）。実行中の段階・ジョブが無い段階は accepted=false と理由 */
  start(stage: CycleStage, jobs: readonly JobDefinition[], actor: string): { accepted: boolean; reason: string | null } {
    const current = this.runs.get(stage);
    if (current && current.finishedAt === null) return { accepted: false, reason: "この段階は実行中（終わってから押す）" };
    if (jobs.length === 0) return { accepted: false, reason: "この段階に定期実行のジョブが無い（人が行う段階）" };
    if (this.controller.signal.aborted) return { accepted: false, reason: "監視アプリが停止中" };
    const ordered = orderStageJobs(jobs);
    const run: CycleStageRun = {
      startedAt: toIsoJst(),
      finishedAt: null,
      actor,
      stoppedReason: null,
      jobs: ordered.map((job) => ({ jobId: job.id, runId: null, state: "waiting", outcome: null })),
    };
    this.runs.set(stage, run);
    logLine("INFO", "cycle", `段階 ${stage} を手動で起動する（${ordered.map((job) => job.id).join(" → ")}）`);
    void this.loop(stage, run, ordered).catch((error: unknown) => {
      run.stoppedReason = "内部エラーで止まった";
      run.finishedAt = toIsoJst();
      logLine("ERROR", "cycle", `段階 ${stage} の実行が止まった: ${error instanceof Error ? error.message : "不明"}`);
    });
    return { accepted: true, reason: null };
  }

  /** 監視アプリの停止（ControlPlane.stop から。冪等）。実行中のジョブはエンジンが打ち切る */
  stop(): void {
    this.controller.abort();
  }

  private async loop(stage: CycleStage, run: CycleStageRun, jobs: readonly JobDefinition[]): Promise<void> {
    for (const [index, job] of jobs.entries()) {
      const entry = run.jobs[index]!;
      if (this.controller.signal.aborted) {
        run.stoppedReason = "監視アプリの停止で、残りを起動しなかった";
        for (const rest of run.jobs.slice(index)) rest.state = "not_run";
        break;
      }
      entry.state = "running";
      const accepted = await this.engine.start({ trigger: "manual", job });
      entry.runId = accepted.runId;
      if (accepted.accepted) await this.waitFinished(accepted.runId, job.timeoutSec * 1000 + WAIT_GRACE_MS);
      const record = this.ctx.runs.get(accepted.runId);
      entry.outcome = record?.status === "finished" ? record.outcome : null;
      entry.state = record?.status === "finished" ? "finished" : "not_run";
      if (entry.state === "not_run") {
        // 停止要求で待つのをやめた・待つ時間を過ぎても終わらない（エンジンの打ち切りより長い）。どちらも次を重ねて起動しない
        run.stoppedReason = this.controller.signal.aborted
          ? "監視アプリの停止で、残りを起動しなかった"
          : `${job.id} が待つ時間内に終わらなかったので、残りを起動しなかった`;
        for (const rest of run.jobs.slice(index + 1)) rest.state = "not_run";
        break;
      }
    }
    run.finishedAt = toIsoJst();
    logLine("INFO", "cycle", `段階 ${stage} の手動の実行が終わった（${run.jobs.map((job) => `${job.jobId}=${job.outcome ?? job.state}`).join(" ")}）`);
  }

  private async waitFinished(runId: Ulid, limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline && !this.controller.signal.aborted) {
      if (this.ctx.runs.get(runId)?.status === "finished") return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, POLL_MS);
        const signal = this.controller.signal;
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
