"use client";

import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Table from "@cloudscape-design/components/table";
import type { JobStatus } from "control-plane";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { RunStatus } from "@/components/runs/RunStatus";
import { EnabledStatus, jobKindLabel, schedulerDescription } from "./job-format";

/** 一覧: 定期実行のジョブ。定義は承認済み main のチェックアウトから読んだもの。 */
export function JobsListView({ jobs }: { jobs: JobStatus[] }) {
  const follow = useFollow();
  return (
    <Table
      variant="full-page"
      stickyHeader
      header={
        <Header variant="awsui-h1-sticky" counter={`(${jobs.length})`} info={<InfoLink />} description={schedulerDescription(jobs)}>
          定期実行のジョブ
        </Header>
      }
      items={jobs}
      trackBy={(job) => job.definition.id}
      empty="定義がありません（ops/schedules/*.yaml を main に入れてください）"
      columnDefinitions={[
        {
          id: "id",
          header: "ID",
          cell: (job) => (
            <Link href={`/jobs/${encodeURIComponent(job.definition.id)}`} onFollow={follow}>
              {job.definition.id}
            </Link>
          ),
        },
        { id: "enabled", header: "有効", cell: (job) => <EnabledStatus enabled={job.definition.enabled} /> },
        { id: "cron", header: "cron（Asia/Tokyo）", cell: (job) => job.definition.cron },
        { id: "kind", header: "種類", cell: (job) => jobKindLabel(job.definition) },
        { id: "after", header: "after", cell: (job) => (job.definition.after.length ? job.definition.after.join(", ") : "-") },
        { id: "next", header: "次回", cell: (job) => formatTime(job.nextRunAt, "minute") },
        {
          id: "last",
          header: "直近の実行",
          cell: (job) =>
            job.lastRun ? (
              <Link href={`/runs/${job.lastRun.runId}`} onFollow={follow}>
                <RunStatus run={job.lastRun} />
              </Link>
            ) : (
              "-"
            ),
        },
      ]}
    />
  );
}
