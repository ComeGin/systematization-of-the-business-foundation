// Route Handler のテストで使う control-plane の差し替え。実体（dist/）は読み込まない
import { vi } from "vitest";
import type { ControlPlane, RunRecord } from "control-plane";

export const SAMPLE_RUN_ID = "01J9ZK3M4N5P6Q7R8S9T0V1W2X";

export function createFakePlane() {
  return {
    start: vi.fn<ControlPlane["start"]>(async () => {}),
    stop: vi.fn<ControlPlane["stop"]>(async () => {}),
    runNow: vi.fn<ControlPlane["runNow"]>(async () => ({ runId: SAMPLE_RUN_ID, accepted: true })),
    listRuns: vi.fn<ControlPlane["listRuns"]>(async () => []),
    getRun: vi.fn<ControlPlane["getRun"]>(async () => null),
    listJobs: vi.fn<ControlPlane["listJobs"]>(async () => []),
    listMiswriteCandidates: vi.fn<ControlPlane["listMiswriteCandidates"]>(async () => []),
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
