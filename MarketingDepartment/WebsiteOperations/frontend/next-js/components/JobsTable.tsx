"use client";

import Header from "@cloudscape-design/components/header";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import type { JobStatus } from "control-plane";
import { RunStatus } from "./RunStatus";

/** 定期実行のジョブ。定義は承認済み main のチェックアウトから読んだもの。 */
export function JobsTable({ jobs }: { jobs: JobStatus[] }) {
  // control-plane の契約には設定の読み出しが無いため、次回の起動予定の有無から定期実行の状態を推定する
  // （有効なジョブがあるのに次回が 1 件も無ければ、CONTROL_SCHEDULER_ENABLED=false）
  const hasEnabled = jobs.some((job) => job.definition.enabled);
  const schedulerOn = jobs.some((job) => job.nextRunAt !== null);
  const description = !hasEnabled
    ? "有効（enabled: true）なジョブがありません"
    : schedulerOn
      ? "定期実行は有効です（CONTROL_SCHEDULER_ENABLED=true）"
      : "定期実行は無効です（CONTROL_SCHEDULER_ENABLED=false）。手動の起動だけ動きます";
  return (
    <Table
      variant="container"
      header={
        <Header
          counter={`(${jobs.length})`}
          description={description}
        >
          定期実行のジョブ
        </Header>
      }
      items={jobs}
      trackBy={(job) => job.definition.id}
      empty="定義がありません（ops/schedules/*.yaml を main に入れてください）"
      columnDefinitions={[
        { id: "id", header: "ID", cell: (job) => job.definition.id },
        {
          id: "enabled",
          header: "有効",
          cell: (job) =>
            job.definition.enabled ? (
              <StatusIndicator type="success">有効</StatusIndicator>
            ) : (
              <StatusIndicator type="stopped">無効</StatusIndicator>
            ),
        },
        { id: "cron", header: "cron（Asia/Tokyo）", cell: (job) => job.definition.cron },
        {
          id: "kind",
          header: "種類",
          cell: (job) =>
            job.definition.kind === "agent" ? `agent/${job.definition.agent}` : `builtin/${job.definition.builtin}`,
        },
        { id: "after", header: "after", cell: (job) => (job.definition.after.length ? job.definition.after.join(", ") : "-") },
        { id: "next", header: "次回", cell: (job) => job.nextRunAt?.slice(0, 16).replace("T", " ") ?? "-" },
        { id: "last", header: "直近の実行", cell: (job) => (job.lastRun ? <RunStatus run={job.lastRun} /> : "-") },
      ]}
    />
  );
}
