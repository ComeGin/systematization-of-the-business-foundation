"use client";

import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { JobDefinition, JobStatus } from "control-plane";

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
