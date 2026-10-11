"use client";

import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { RunRecord } from "control-plane";

/** E-15 の run の状態表示。running は outcome が未確定。 */
export function RunStatus({ run }: { run: Pick<RunRecord, "status" | "outcome"> }) {
  if (run.status === "running") return <StatusIndicator type="in-progress">実行中</StatusIndicator>;
  switch (run.outcome) {
    case "success":
      return <StatusIndicator type="success">成功</StatusIndicator>;
    case "partial":
      return <StatusIndicator type="warning">一部のみ</StatusIndicator>;
    case "failure":
      return <StatusIndicator type="error">失敗</StatusIndicator>;
    case "skipped":
      return <StatusIndicator type="stopped">見送り</StatusIndicator>;
    default:
      return <StatusIndicator type="pending">不明</StatusIndicator>;
  }
}

/** 一覧に出す名前: job（あれば）→ エージェント名 → builtin。 */
export function runLabel(run: Pick<RunRecord, "jobId" | "agentName" | "builtin">): string {
  const target = run.agentName ? `agent/${run.agentName}` : run.builtin ? `builtin/${run.builtin}` : "-";
  return run.jobId ? `${run.jobId}（${target}）` : target;
}
