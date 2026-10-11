"use client";

import Link from "@cloudscape-design/components/link";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import type { RunRecord } from "control-plane";
import { formatTime, useFollow } from "@/components/common/navigation";
import { RunStatus, runLabel } from "./RunStatus";

export const TRIGGER_LABEL = { schedule: "定期", manual: "手動", proposal: "提案" } as const;

/**
 * 実行記録（E-15）の表。一覧の画面（full-page）と、ジョブの詳細の子リソース（container）で使う。
 * 時系列（新しい順）に並んだまま渡す。
 */
export function RunsTable({
  runs,
  header,
  variant,
  empty = "実行記録はまだありません",
}: {
  runs: RunRecord[];
  header: React.ReactNode;
  variant: TableProps.Variant;
  empty?: React.ReactNode;
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
        { id: "target", header: "対象", cell: (run) => runLabel(run) },
        { id: "trigger", header: "起動", cell: (run) => TRIGGER_LABEL[run.trigger] },
        { id: "startedAt", header: "開始", cell: (run) => formatTime(run.startedAt) },
        { id: "summary", header: "要約", cell: (run) => run.skipReason ?? run.summary ?? "-" },
        { id: "failureClass", header: "失敗分類", cell: (run) => run.failureClass ?? "-" },
        {
          id: "copied",
          header: "S3 の写し",
          cell: (run) => (run.status === "running" ? "-" : run.copiedAt ? "済" : "未送"),
        },
      ]}
    />
  );
}
