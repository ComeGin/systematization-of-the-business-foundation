"use client";

import Link from "@cloudscape-design/components/link";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import type { RunObservations, RunRecord } from "control-plane";
import { describeOutcome } from "@/components/common/failure-class";
import { formatTime, useFollow } from "@/components/common/navigation";
import { ContentStatus } from "./ContentStatus";
import { RunStatus, runLabel } from "./RunStatus";

export const TRIGGER_LABEL = { schedule: "定期", manual: "手動", proposal: "提案" } as const;

/**
 * 実行記録（E-15）の表。一覧の画面（full-page）と、ジョブの詳細の子リソース（container）で使う。
 * 時系列（新しい順）に並んだまま渡す。observations（runId → 観測）を渡すと「中身」の列を出す。
 */
export function RunsTable({
  runs,
  header,
  variant,
  empty = "実行記録はまだありません",
  observations,
}: {
  runs: RunRecord[];
  header: React.ReactNode;
  variant: TableProps.Variant;
  empty?: React.ReactNode;
  observations?: Record<string, RunObservations>;
}) {
  const follow = useFollow();
  return (
    <Table
      variant={variant}
      stickyHeader={variant === "full-page"}
      header={header}
      items={runs}
      trackBy="runId"
      empty={empty}
      columnDefinitions={[
        {
          id: "runId",
          header: "相関 ID",
          cell: (run) => (
            <Link href={`/runs/${run.runId}`} onFollow={follow}>
              {run.runId}
            </Link>
          ),
        },
        { id: "status", header: "状態", cell: (run) => <RunStatus run={run} /> },
        ...(observations
          ? [{ id: "content", header: "中身", cell: (run: RunRecord) => <ContentStatus observations={observations[run.runId]} /> }]
          : []),
        { id: "target", header: "対象", cell: (run) => runLabel(run) },
        { id: "trigger", header: "起動", cell: (run) => TRIGGER_LABEL[run.trigger] },
        { id: "startedAt", header: "開始", cell: (run) => formatTime(run.startedAt) },
        { id: "summary", header: "要約", cell: (run) => run.skipReason ?? run.summary ?? "-" },
        {
          id: "failureClass",
          header: "失敗分類",
          cell: (run) => (run.failureClass ? `${run.failureClass}（${describeOutcome(run.failureClass).label}）` : "-"),
        },
        {
          id: "copied",
          header: "S3 の写し",
          cell: (run) => (run.status === "running" ? "-" : run.copiedAt ? "済" : "未送"),
        },
      ]}
    />
  );
}
