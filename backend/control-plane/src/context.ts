import type { ControlPlaneConfig } from "./config.js";
import type { FailureClass, RunOutcome } from "./contract.js";
import type { LoadedSchedules, ScheduleDefinition } from "./definitions/schedules.js";
import type { RunLogCopier } from "./integrations/runlog.js";
import type { KvStore } from "./store/kv.js";
import type { LeaseStore } from "./store/leases.js";
import type { MiswriteStore } from "./store/miswrite.js";
import type { RunStore } from "./store/runs.js";

/** 実行（エージェント・builtin）が返す結果。E-15 に書くのはエンジンで、実行側は書かない。 */
export interface RunResult {
  outcome: RunOutcome;
  /** 個人情報を含まない要約。エンジンが記録の前に PII 検査を通す。 */
  summary: string | null;
  targetIds: string[];
  skipReason?: string | null;
  failureClass?: FailureClass | null;
  sdkSubtype?: string | null;
  costUsd?: number | null;
}

export interface EngineContext {
  config: ControlPlaneConfig;
  runs: RunStore;
  leases: LeaseStore;
  kv: KvStore;
  miswrite: MiswriteStore;
  loadSchedules(): Promise<LoadedSchedules>;
  /** AWS が無効なら null */
  copier: RunLogCopier | null;
}

export interface BuiltinInput {
  ctx: EngineContext;
  runId: string;
  signal: AbortSignal;
  timeoutSec: number;
  /** 手動で builtin を直接起動することは無いので、定義から起動したときだけ入る */
  job: ScheduleDefinition | null;
}

export type BuiltinHandler = (input: BuiltinInput) => Promise<RunResult>;
