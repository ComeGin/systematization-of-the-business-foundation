import type { ControlPlaneConfig } from "./config.js";
import type { FailureClass, RunOutcome } from "./contract.js";
import type { LoadedSchedules, ScheduleDefinition } from "./definitions/schedules.js";
import type { RunLogCopier } from "./integrations/runlog.js";
import type { CycleStore } from "./store/cycles.js";
import type { KvStore } from "./store/kv.js";
import type { LeaseStore } from "./store/leases.js";
import type { MiswriteStore } from "./store/miswrite.js";
import type { ModelSettingsStore } from "./store/models.js";
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
  /** 実行に使ったモデル（2026-11-12。E-15 の model） */
  model?: string | null;
}

export interface EngineContext {
  config: ControlPlaneConfig;
  runs: RunStore;
  leases: LeaseStore;
  kv: KvStore;
  cycles: CycleStore;
  miswrite: MiswriteStore;
  /** 画面で選んだ実行モデル（2026-11-12） */
  models: ModelSettingsStore;
  /** E-15 の SQLite を、一貫した 1 時点の写しとして dest に書き出す（VACUUM INTO。builtin backup が使う。2026-11-12） */
  snapshotE15(dest: string): void;
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
