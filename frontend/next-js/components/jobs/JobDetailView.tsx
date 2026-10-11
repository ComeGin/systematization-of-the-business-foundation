"use client";

import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { JobStatus, RunRecord } from "control-plane";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { RunStatus } from "@/components/runs/RunStatus";
import { RunsTable } from "@/components/runs/RunsTable";
import { EnabledStatus, jobKindLabel } from "./job-format";

/**
 * 詳細: 定期実行のジョブ 1 件。定義は承認済み main の ops/schedules/<id>.yaml で、画面からは変えない（ADR-18）。
 * 子リソースはこのジョブの実行記録（新しい順）。
 */
export function JobDetailView({ job, runs, runLimit }: { job: JobStatus; runs: RunRecord[]; runLimit: number }) {
  const follow = useFollow();
  const { definition } = job;
  const jobHref = (id: string) => `/jobs/${encodeURIComponent(id)}`;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          info={<InfoLink />}
          description={definition.description}
          actions={
            <Button variant="primary" href={`/runs/new?jobId=${encodeURIComponent(definition.id)}`} onFollow={follow}>
              手動で起動
            </Button>
          }
        >
          {definition.id}
        </Header>
      }
    >
      <AutoRefresh active={runs.some((run) => run.status === "running")} />
      <SpaceBetween size="l">
        <Container
          header={
            <Header variant="h2" description={`承認済み main の ops/schedules/${definition.id}.yaml（画面からは変えません）`}>
              定義
            </Header>
          }
        >
          <KeyValuePairs
            columns={3}
            items={[
              { label: "有効", value: <EnabledStatus enabled={definition.enabled} /> },
              { label: "種類", value: jobKindLabel(definition) },
              { label: "cron（Asia/Tokyo）", value: definition.cron },
              {
                label: "after",
                value: definition.after.length ? (
                  <SpaceBetween size="xxs" direction="horizontal">
                    {definition.after.map((id) => (
                      <Link key={id} href={jobHref(id)} onFollow={follow}>
                        {id}
                      </Link>
                    ))}
                  </SpaceBetween>
                ) : (
                  "-"
                ),
              },
              { label: "上限の秒数", value: definition.timeoutSec },
              { label: "最大ターン数", value: definition.maxTurns ?? "-" },
              { label: "次回", value: formatTime(job.nextRunAt, "minute") },
              {
                label: "直近の実行",
                value: job.lastRun ? (
                  <Link href={`/runs/${job.lastRun.runId}`} onFollow={follow}>
                    <RunStatus run={job.lastRun} />
                  </Link>
                ) : (
                  "-"
                ),
              },
            ]}
          />
        </Container>

        <RunsTable
          variant="container"
          runs={runs}
          empty="このジョブの実行記録はまだありません"
          header={
            <Header variant="h2" counter={`(${runs.length})`} description={`新しい順。最大 ${runLimit} 件`}>
              このジョブの実行記録
            </Header>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
