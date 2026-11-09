// Route Handler のテストで使う control-plane の差し替え。実体（dist/）は読み込まない
import { vi } from "vitest";
import type { AgentInfo, ControlPlane, CycleView, JobDefinition, JobStatus, ObservationSummary, RunObservations, RunRecord } from "control-plane";

export const SAMPLE_RUN_ID = "01J9ZK3M4N5P6Q7R8S9T0V1W2X";

/** 周が無いときの画面（改善ループの差し替えの既定） */
const EMPTY_CYCLE_VIEW: CycleView = {
  cycle: null,
  reason: "テスト",
  stages: [],
  items: [],
  summary: { proposals: 0, reflected: 0, awaiting: 0, rejected: 0, stuck: 0, keywordReflected: 0 },
  previousVerification: [],
};

export function createFakePlane() {
  return {
    start: vi.fn<ControlPlane["start"]>(async () => {}),
    stop: vi.fn<ControlPlane["stop"]>(async () => {}),
    runNow: vi.fn<ControlPlane["runNow"]>(async () => ({ runId: SAMPLE_RUN_ID, accepted: true })),
    listRuns: vi.fn<ControlPlane["listRuns"]>(async () => []),
    getRun: vi.fn<ControlPlane["getRun"]>(async () => null),
    listJobs: vi.fn<ControlPlane["listJobs"]>(async () => []),
    listRunObservations: vi.fn<ControlPlane["listRunObservations"]>(async () => []),
    listAgents: vi.fn<ControlPlane["listAgents"]>(async () => ({ agents: [], errors: [] })),
    getAgent: vi.fn<ControlPlane["getAgent"]>(async () => null),
    listMiswriteCandidates: vi.fn<ControlPlane["listMiswriteCandidates"]>(async () => []),
    getSetupStatus: vi.fn<ControlPlane["getSetupStatus"]>(async () => ({
      enabled: false,
      reason: "本番の監視アプリだけで動く（CONTROL_SETUP_STATUS_ENABLED が true ではない）",
      checkedAt: null,
      nextCheckAt: null,
      running: false,
      counts: { ok: 0, action: 0, warn: 0, manual: 0, unknown: 0 },
      notifyError: null,
      steps: [],
    })),
    refreshSetupStatus: vi.fn<ControlPlane["refreshSetupStatus"]>(async () => ({ accepted: false })),
    readSetupDoc: vi.fn<ControlPlane["readSetupDoc"]>(async () => null),
    getCycle: vi.fn<ControlPlane["getCycle"]>(async () => EMPTY_CYCLE_VIEW),
    listCycles: vi.fn<ControlPlane["listCycles"]>(async () => []),
    approveCycleItem: vi.fn<ControlPlane["approveCycleItem"]>(async () => EMPTY_CYCLE_VIEW),
    rejectCycleItem: vi.fn<ControlPlane["rejectCycleItem"]>(async () => EMPTY_CYCLE_VIEW),
    markCycleItemExecuted: vi.fn<ControlPlane["markCycleItemExecuted"]>(async () => ({ accepted: true })),
    startCycle: vi.fn<ControlPlane["startCycle"]>(async () => EMPTY_CYCLE_VIEW),
  } satisfies ControlPlane;
}

export type FakePlane = ReturnType<typeof createFakePlane>;

export function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: SAMPLE_RUN_ID,
    jobId: "daily-seo",
    agentName: "seo-auditor",
    builtin: null,
    trigger: "schedule",
    status: "finished",
    startedAt: "2026-10-05T09:00:00+09:00",
    finishedAt: "2026-10-05T09:05:00+09:00",
    outcome: "success",
    summary: "要約",
    summaryRedacted: false,
    targetIds: [],
    skipReason: null,
    failureClass: "ok",
    sdkSubtype: "success",
    costUsd: 0.12,
    copiedAt: null,
    ...overrides,
  };
}

/** 状態を変える要求（同じオリジン）を作る */
export function sameOriginInit(body: unknown): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: "POST",
    headers: { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200", "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

export function makeObservation(overrides: Partial<ObservationSummary> = {}): ObservationSummary {
  return {
    auditId: "AUD-2026-1106-gsc-0001",
    source: "gsc",
    createdBy: "agent/seo-auditor",
    outcome: "ok",
    note: null,
    measuredAt: "2026-11-06T04:00:40+09:00",
    found: true,
    ...overrides,
  };
}

export function makeObservations(overrides: Partial<RunObservations> = {}): RunObservations {
  return { runId: SAMPLE_RUN_ID, written: [], referenced: [], ...overrides };
}

export function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    name: "seo-auditor",
    description: "GSC の実績を E-12 に正規化する観測エージェント。提案はしない。",
    model: "sonnet",
    disallowedTools: [],
    toolGroups: [],
    body: "手順",
    jobIds: [],
    ...overrides,
  };
}

export function makeJob(id: string, agent: string | null, overrides: Partial<JobDefinition> = {}): JobStatus {
  return {
    definition: {
      id,
      description: `${id} の説明`,
      enabled: true,
      cron: "0 4 * * *",
      kind: agent ? "agent" : "builtin",
      agent,
      builtin: agent ? null : "heartbeat",
      after: [],
      timeoutSec: 600,
      maxTurns: null,
      prompt: agent ? "指示" : null,
      overview: null,
      stage: null,
      io: null,
      cycleDays: null,
      proposalKinds: null,
      ...overrides,
    },
    nextRunAt: null,
    lastRun: null,
  };
}
