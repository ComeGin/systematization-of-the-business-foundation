"use client";

import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Table from "@cloudscape-design/components/table";
import type { RunRecord } from "control-plane";
import { useRouter } from "next/navigation";
import { AutoRefresh } from "./AutoRefresh";
import { RunStatus, runLabel } from "./RunStatus";

const TRIGGER_LABEL = { schedule: "定期", manual: "手動", proposal: "提案" } as const;

/** 実行の一覧（E-15）。実行中の run があれば自動で読み直す。 */
export function RunsTable({ runs }: { runs: RunRecord[] }) {
  const router = useRouter();
  return (
    <>
      <AutoRefresh active={runs.some((run) => run.status === "running")} />
      <Table
        variant="container"
        header={<Header counter={`(${runs.length})`} description="新しい順。最大 50 件">実行記録（E-15）</Header>}
        items={runs}
        trackBy="runId"
        empty="実行記録はまだありません"
        columnDefinitions={[
          {
            id: "runId",
            header: "相関 ID",
            cell: (run) => (
              <Link
                href={`/runs/${run.runId}`}
                onFollow={(event) => {
                  event.preventDefault();
                  router.push(`/runs/${run.runId}`);
                }}
              >
                {run.runId}
              </Link>
            ),
          },
          { id: "status", header: "状態", cell: (run) => <RunStatus run={run} /> },
          { id: "target", header: "対象", cell: (run) => runLabel(run) },
          { id: "trigger", header: "起動", cell: (run) => TRIGGER_LABEL[run.trigger] },
          { id: "startedAt", header: "開始", cell: (run) => run.startedAt.slice(0, 19).replace("T", " ") },
          { id: "summary", header: "要約", cell: (run) => run.skipReason ?? run.summary ?? "-" },
          { id: "failureClass", header: "失敗分類", cell: (run) => run.failureClass ?? "-" },
          {
            id: "copied",
            header: "S3 の写し",
            cell: (run) => (run.status === "running" ? "-" : run.copiedAt ? "済" : "未送"),
          },
        ]}
      />
    </>
  );
}
