// control-plane の入口。監視アプリ（frontend/next-js）はここから export した型と createControlPlane だけを使う。
// 境界の型は contract.ts（リード所有）。
import type { DatabaseSync } from "node:sqlite";
import { loadControlPlaneConfig, type ControlPlaneConfig } from "./config.js";
import type { EngineContext } from "./context.js";
import type {
  AgentInfo,
  AgentListing,
  ControlPlane,
  CreateControlPlane,
  CycleId,
  CycleRow,
  CycleStage,
  CycleView,
  JobStatus,
  ListRunsQuery,
  ManualRunAccepted,
  ManualRunRequest,
  ModelSettingTarget,
  ModelSettingsView,
  RunObservations,
  MiswriteCandidate,
  RunRecord,
  SetupDocSection,
  SetupStatusView,
  Ulid,
} from "./contract.js";
import { buildAgentInfo, listAgentDefinitions } from "./definitions/agent-catalog.js";
import { AGENT_NAME_PATTERN, AgentDefinitionError, loadAgentDefinition } from "./definitions/agent-def.js";
import { type McpRegistry, loadMcpRegistry } from "./definitions/registry.js";
import { auditDatesForRuns, loadAuditIndex, observationsForRun } from "./definitions/audits.js";
import { type LoadedSchedules } from "./definitions/schedules.js";
import { CycleService, STAGES, stageJobs } from "./cycle/service.js";
import { StageRunner } from "./cycle/stage-runner.js";
import { Engine } from "./engine.js";
import { ModelService } from "./models/service.js";
import { ControlPlaneInputError } from "./errors.js";
import { createCloudWatchClient, putHeartbeat } from "./integrations/aws.js";
import { RunLogCopier } from "./integrations/runlog.js";
import { logLine } from "./log.js";
import { Scheduler, nextRunAt } from "./scheduler.js";
import { SetupStatusService } from "./status/service.js";
import { openE15Database, snapshotDatabase } from "./store/db.js";
import { CycleStore } from "./store/cycles.js";
import { KvStore } from "./store/kv.js";
import { LeaseStore } from "./store/leases.js";
import { MiswriteStore } from "./store/miswrite.js";
import { ModelSettingsStore } from "./store/models.js";
import { RunStore } from "./store/runs.js";
import { toIsoJst } from "./time.js";
import { ULID_PATTERN } from "./ulid.js";
import { loadSchedules } from "./definitions/schedules.js";

export type * from "./contract.js";
export { ConfigError, loadControlPlaneConfig, resolveDataDir, type ControlPlaneConfig } from "./config.js";
export { openAuthDatabase } from "./store/db.js";
/** Agent の名前の形。next-js の lib/ids.ts の写しが同じかをテストで確かめるために公開する（2026-11-09） */
export { AGENT_NAME_PATTERN } from "./definitions/agent-def.js";

/** 手動の起動・画面の操作の入力が不正（呼び出し側の誤り）。実体は errors.ts（cycle/service.ts と共有するため） */
export { ControlPlaneInputError } from "./errors.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const RUNLOG_FLUSH_INTERVAL_MS = 10 * 60 * 1000;
const SCHEDULES_CACHE_MS = 5_000;
const MAX_MANUAL_PROMPT_LENGTH = 20_000;

/** listRunObservations が 1 回に扱う実行の数（実行記録の一覧の上限と同じ） */
const MAX_OBSERVATION_RUNS = 200;

class ControlPlaneImpl implements ControlPlane {
  private readonly db: DatabaseSync;
  private readonly ctx: EngineContext;
  private readonly engine: Engine;
  private readonly scheduler: Scheduler;
  private readonly setupStatus: SetupStatusService;
  private readonly cycleService: CycleService;
  private readonly stageRunner: StageRunner;
  private readonly modelService: ModelService;
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
      cycles: new CycleStore(this.db),
      miswrite: new MiswriteStore(this.db),
      models: new ModelSettingsStore(this.db),
      snapshotE15: (dest) => snapshotDatabase(this.db, dest),
      loadSchedules: () => this.loadSchedules(),
      copier: config.aws ? new RunLogCopier(runs, config.aws) : null,
    };
    this.engine = new Engine(this.ctx);
    this.scheduler = new Scheduler(this.ctx, this.engine);
    this.setupStatus = new SetupStatusService(config);
    this.stageRunner = new StageRunner(this.ctx, this.engine);
    this.cycleService = new CycleService(this.ctx, this.stageRunner);
    this.modelService = new ModelService(config, this.ctx.models);
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

    // 設定の状況は監視（改善ループの処理ではない）なので、CONTROL_SCHEDULER_ENABLED とも 0〜8 時の窓とも無関係に動かす
    if (this.config.status) this.setupStatus.start();

    if (this.config.schedulerEnabled) await this.scheduler.start();
    logLine(
      "INFO",
      "control-plane",
      `開始 scheduler=${this.config.schedulerEnabled ? "on" : "off"} heartbeat=${aws ? "on" : "off(AWS 未設定)"} setup-status=${this.config.status ? "on" : "off"}`,
    );
  }

  async stop(): Promise<void> {
    // runNow は start() の前でも受け付けるため、実行中の打ち切りは started に関わらず行う（契約の「実行中のエージェントを打ち切り」）
    const wasStarted = this.started;
    this.started = false;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.scheduler.stop();
    this.setupStatus.stop();
    this.cycleService.stop();
    this.stageRunner.stop();
    await this.engine.stopAll();
    if (wasStarted) logLine("INFO", "control-plane", "停止");
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
    return jobs.map((definition) => ({
      definition,
      nextRunAt: this.config.schedulerEnabled && definition.enabled ? nextRunAt(definition) : null,
      lastRun: this.ctx.runs.latestByJob(definition.id),
    }));
  }

  async listRunObservations(runIds: Ulid[]): Promise<RunObservations[]> {
    const runs = runIds
      .slice(0, MAX_OBSERVATION_RUNS)
      .filter((runId) => ULID_PATTERN.test(runId))
      .map((runId) => this.ctx.runs.get(runId))
      .filter((run): run is RunRecord => run !== null);
    if (runs.length === 0) return [];
    const index = await loadAuditIndex(
      { worktree: this.config.worktree, mainCheckout: this.config.mainCheckout },
      { dates: auditDatesForRuns(runs) },
    );
    return runs.map((run) => observationsForRun(run, index));
  }

  async listAgents(): Promise<AgentListing> {
    const [{ definitions, errors }, { jobs }, registry] = await Promise.all([
      listAgentDefinitions(this.config.mainCheckout),
      this.loadSchedules(true),
      this.loadRegistryForDisplay(),
    ]);
    return { agents: definitions.map((definition) => buildAgentInfo(definition, jobs, registry)), errors };
  }

  async getAgent(name: string): Promise<AgentInfo | null> {
    if (!AGENT_NAME_PATTERN.test(name)) return null;
    let definition;
    try {
      definition = await loadAgentDefinition(this.config.mainCheckout, name);
    } catch (error) {
      if (error instanceof AgentDefinitionError) return null;
      throw error;
    }
    const [{ jobs }, registry] = await Promise.all([this.loadSchedules(true), this.loadRegistryForDisplay()]);
    return buildAgentInfo(definition, jobs, registry);
  }

  /** 表示のための登録表。壊れていても画面は出す（access_level を出さないだけ）。起動の検査は runner が別に行う */
  private async loadRegistryForDisplay(): Promise<McpRegistry> {
    try {
      return await loadMcpRegistry(this.config.mainCheckout);
    } catch (error) {
      logLine("WARN", "control-plane", `表示のための MCP の登録表を読めない（${errorName(error)}）`);
      return { servers: new Map() };
    }
  }

  async listMiswriteCandidates(): Promise<MiswriteCandidate[]> {
    return this.ctx.miswrite.list();
  }

  async getSetupStatus(): Promise<SetupStatusView> {
    const view = this.setupStatus.view();
    return { ...view, guide: await this.setupStatus.guide(view) };
  }

  async refreshSetupStatus(): Promise<{ accepted: boolean }> {
    return this.setupStatus.refresh();
  }

  async readSetupDoc(file: string, heading: string): Promise<SetupDocSection | null> {
    return this.setupStatus.readDoc(file, heading);
  }

  // ---- 改善ループ（実体は cycle/service.ts） ----

  async getCycle(cycleId?: CycleId): Promise<CycleView> {
    return this.cycleService.getCycle(cycleId);
  }

  async listCycles(): Promise<CycleRow[]> {
    return this.cycleService.listCycles();
  }

  async approveCycleItem(itemId: Ulid, checked: string[], actor: string, expectedUpdatedAt: string): Promise<CycleView> {
    return this.cycleService.approveCycleItem(itemId, checked, actor, expectedUpdatedAt);
  }

  async rejectCycleItem(itemId: Ulid, reason: string, actor: string): Promise<CycleView> {
    return this.cycleService.rejectCycleItem(itemId, reason, actor);
  }

  async markCycleItemExecuted(itemId: Ulid, actor: string): Promise<{ accepted: boolean }> {
    return this.cycleService.markCycleItemExecuted(itemId, actor);
  }

  async startCycle(actor: string): Promise<CycleView> {
    return this.cycleService.startCycle(actor);
  }

  async runCycleStage(stage: CycleStage, actor: string): Promise<{ accepted: boolean; reason: string | null }> {
    if (!STAGES.includes(stage)) throw new ControlPlaneInputError("段階が不正");
    const who = actor.trim();
    if (!who || who.length > 200) throw new ControlPlaneInputError("操作した人が不正");
    const { jobs } = await this.loadSchedules(true);
    return this.stageRunner.start(stage, stageJobs(stage, jobs), who);
  }

  async getModelSettings(): Promise<ModelSettingsView> {
    return this.modelService.getView();
  }

  async setModelSetting(target: ModelSettingTarget, model: string | null, actor: string): Promise<ModelSettingsView> {
    const view = await this.modelService.set(target, model, actor);
    const scope = target.provider === "openai" ? "openai:image" : target.agent === null ? "anthropic:default" : `anthropic:agent:${target.agent}`;
    logLine("INFO", "models", `実行モデルを ${model === null ? "既定に戻した" : `${model} にした`}（${scope}）`);
    return view;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "不明";
}

export const createControlPlane: CreateControlPlane = (options) =>
  new ControlPlaneImpl(loadControlPlaneConfig(options?.env ?? process.env));
