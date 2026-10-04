// control-plane の入口。監視アプリ（frontend/next-js）はここから export した型と createControlPlane だけを使う。
// 境界の型は contract.ts（リード所有）。
import type { DatabaseSync } from "node:sqlite";
import { loadControlPlaneConfig, type ControlPlaneConfig } from "./config.js";
import type { EngineContext } from "./context.js";
import type {
  ControlPlane,
  CreateControlPlane,
  JobStatus,
  ListRunsQuery,
  ManualRunAccepted,
  ManualRunRequest,
  MiswriteCandidate,
  RunRecord,
  Ulid,
} from "./contract.js";
import { AGENT_NAME_PATTERN } from "./definitions/agent-def.js";
import { type LoadedSchedules } from "./definitions/schedules.js";
import { Engine } from "./engine.js";
import { createCloudWatchClient, putHeartbeat } from "./integrations/aws.js";
import { RunLogCopier } from "./integrations/runlog.js";
import { logLine } from "./log.js";
import { Scheduler, nextRunAt } from "./scheduler.js";
import { openE15Database } from "./store/db.js";
import { KvStore } from "./store/kv.js";
import { LeaseStore } from "./store/leases.js";
import { MiswriteStore } from "./store/miswrite.js";
import { RunStore } from "./store/runs.js";
import { toIsoJst } from "./time.js";
import { loadSchedules } from "./definitions/schedules.js";

export type * from "./contract.js";
export { ConfigError, loadControlPlaneConfig, resolveDataDir, type ControlPlaneConfig } from "./config.js";
export { openAuthDatabase } from "./store/db.js";

/** 手動の起動の入力が不正（呼び出し側の誤り。画面・API では 4xx にする）。 */
export class ControlPlaneInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneInputError";
  }
}

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const RUNLOG_FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const SCHEDULES_CACHE_MS = 5_000;
const MAX_MANUAL_PROMPT_LENGTH = 20_000;

class ControlPlaneImpl implements ControlPlane {
  private readonly db: DatabaseSync;
  private readonly ctx: EngineContext;
  private readonly engine: Engine;
  private readonly scheduler: Scheduler;
  private readonly timers: NodeJS.Timeout[] = [];
  private started = false;
  private schedulesCache: { at: number; value: LoadedSchedules } | null = null;

  constructor(private readonly config: ControlPlaneConfig) {
    this.db = openE15Database(config.dataDir);
    const runs = new RunStore(this.db);
    this.ctx = {
      config,
      runs,
      leases: new LeaseStore(this.db),
      kv: new KvStore(this.db),
      miswrite: new MiswriteStore(this.db),
      loadSchedules: () => this.loadSchedules(),
      copier: config.aws ? new RunLogCopier(runs, config.aws) : null,
    };
    this.engine = new Engine(this.ctx);
    this.scheduler = new Scheduler(this.ctx, this.engine);
  }

  private async loadSchedules(fresh = false): Promise<LoadedSchedules> {
    const now = Date.now();
    if (!fresh && this.schedulesCache && now - this.schedulesCache.at < SCHEDULES_CACHE_MS) return this.schedulesCache.value;
    const value = await loadSchedules(this.config.mainCheckout);
    this.schedulesCache = { at: now, value };
    return value;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.interruptStaleRuns();

    // 起動時に未送の写しを送り直す（失敗しても E-15 に残る）
    void this.ctx.copier?.flush().catch((error: unknown) => logLine("WARN", "runlog", `起動時の再送に失敗: ${errorName(error)}`));

    const { aws } = this.config;
    if (aws) {
      const client = createCloudWatchClient(aws);
      const beat = () =>
        putHeartbeat(client, aws).catch((error: unknown) =>
          logLine("WARN", "heartbeat", `ハートビートの送信に失敗: ${errorName(error)}`),
        );
      // ハートビートは E-15 に記録しない（5 分ごと = 1 日 288 件になり、実行記録が埋もれるため）
      void beat();
      this.timers.push(setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS));
      this.timers.push(
        setInterval(
          () =>
            void this.ctx.copier?.flush().catch((error: unknown) =>
              logLine("WARN", "runlog", `定期の再送に失敗: ${errorName(error)}`),
            ),
          RUNLOG_FLUSH_INTERVAL_MS,
        ),
      );
    }
    for (const timer of this.timers) timer.unref();

    if (this.config.schedulerEnabled) await this.scheduler.start();
    logLine(
      "INFO",
      "control-plane",
      `開始 scheduler=${this.config.schedulerEnabled ? "on" : "off"} heartbeat=${aws ? "on" : "off(AWS 未設定)"}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.scheduler.stop();
    await this.engine.stopAll();
    logLine("INFO", "control-plane", "停止");
  }

  /** 前回のプロセスが落ちて running のまま残った run を、failure に確定する（持ち主が他で生きていれば触らない）。 */
  private interruptStaleRuns(): void {
    for (const run of this.ctx.runs.running()) {
      if (this.ctx.leases.heldElsewhere(run.runId)) continue;
      this.ctx.runs.finish(run.runId, {
        finishedAt: toIsoJst(),
        outcome: "failure",
        summary: "プロセスの停止または再起動で中断された",
        summaryRedacted: false,
        targetIds: run.targetIds,
        skipReason: null,
        failureClass: "timeout",
        sdkSubtype: null,
        costUsd: null,
      });
      this.ctx.leases.releaseByRun(run.runId);
      logLine("WARN", "control-plane", "中断された run を確定した", run.runId);
    }
  }

  async runNow(request: ManualRunRequest): Promise<ManualRunAccepted> {
    const { target } = request;
    if (target.kind === "job") {
      const { jobs } = await this.loadSchedules(true);
      const job = jobs.find((candidate) => candidate.id === target.jobId);
      if (!job) throw new ControlPlaneInputError(`定期実行の定義が見つからない: ${target.jobId}`);
      // 手動の起動は enabled:false でも許す（自動の起動だけを止めるため）
      return this.engine.start({ trigger: "manual", job });
    }
    if (!AGENT_NAME_PATTERN.test(target.agent)) throw new ControlPlaneInputError("エージェント名が不正");
    const prompt = target.prompt.trim();
    if (!prompt) throw new ControlPlaneInputError("プロンプトが空");
    if (prompt.length > MAX_MANUAL_PROMPT_LENGTH) throw new ControlPlaneInputError("プロンプトが長すぎる");
    return this.engine.start({ trigger: "manual", adHoc: { agent: target.agent, prompt } });
  }

  async listRuns(query?: ListRunsQuery): Promise<RunRecord[]> {
    return this.ctx.runs.list(query);
  }

  async getRun(runId: Ulid): Promise<RunRecord | null> {
    return this.ctx.runs.get(runId);
  }

  async listJobs(): Promise<JobStatus[]> {
    const { jobs } = await this.loadSchedules();
    return jobs.map(({ prompt: _prompt, ...definition }) => ({
      definition,
      nextRunAt: this.config.schedulerEnabled && definition.enabled ? nextRunAt({ ...definition, prompt: null }) : null,
      lastRun: this.ctx.runs.latestByJob(definition.id),
    }));
  }

  async listMiswriteCandidates(): Promise<MiswriteCandidate[]> {
    return this.ctx.miswrite.list();
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "不明";
}

export const createControlPlane: CreateControlPlane = (options) =>
  new ControlPlaneImpl(loadControlPlaneConfig(options?.env ?? process.env));
