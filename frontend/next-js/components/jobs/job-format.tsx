"use client";

import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { JobDefinition, JobIo, JobStage, JobStatus } from "control-plane";

/** 改善ループの中の段階（設計 2026-11-06 の 4 節）。この順に並べる */
export const STAGES = ["measure", "observe", "propose", "file", "create", "check", "maintain", "monitor"] as const satisfies readonly JobStage[];

const STAGE_LABEL: Record<JobStage, string> = {
  measure: "計測",
  observe: "観測",
  propose: "提案",
  file: "起票",
  create: "制作",
  check: "点検",
  maintain: "保守",
  monitor: "監視",
};

/** 定義に書かれていない欄の表示 */
export const NOT_WRITTEN = "（定義に書かれていない）";

export function stageLabel(stage: JobStage | null): string {
  return stage ? STAGE_LABEL[stage] : NOT_WRITTEN;
}

/** 入出力の 1 欄。io が無ければ notWritten、io があって欄が空なら none（「なし」） */
export function ioItems(
  io: JobIo | null,
  key: keyof JobIo,
): { kind: "items"; items: string[] } | { kind: "none" } | { kind: "notWritten" } {
  if (!io) return { kind: "notWritten" };
  return io[key].length ? { kind: "items", items: io[key] } : { kind: "none" };
}

/** その id を after に持つジョブ（「待たれるもの」）。id の順 */
export function dependentsOf(jobId: string, jobs: readonly JobDefinition[]): string[] {
  return jobs
    .filter((job) => job.after.includes(jobId))
    .map((job) => job.id)
    .sort();
}

export function EnabledStatus({ enabled }: { enabled: boolean }) {
  return enabled ? <StatusIndicator type="success">有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>;
}

export function jobKindLabel(definition: Pick<JobDefinition, "kind" | "agent" | "builtin">): string {
  return definition.kind === "agent" ? `agent/${definition.agent}` : `builtin/${definition.builtin}`;
}

/**
 * control-plane の契約には設定の読み出しが無いため、次回の起動予定の有無から定期実行の状態を推定する
 * （有効なジョブがあるのに次回が 1 件も無ければ、CONTROL_SCHEDULER_ENABLED=false）。
 */
export function schedulerDescription(jobs: JobStatus[]): string {
  if (!jobs.some((job) => job.definition.enabled)) return "有効（enabled: true）なジョブがありません";
  return jobs.some((job) => job.nextRunAt !== null)
    ? "定期実行は有効です（CONTROL_SCHEDULER_ENABLED=true）"
    : "定期実行は無効です（CONTROL_SCHEDULER_ENABLED=false）。手動の起動だけ動きます";
}
