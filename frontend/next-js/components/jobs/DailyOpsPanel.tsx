"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import type { JobStatus, RunRecord } from "control-plane";
import { formatTime, useFollow } from "@/components/common/navigation";
import { RunStatus } from "@/components/runs/RunStatus";

// 「毎日の運用」: 毎日、人が手動で起動するジョブ（ops/schedules の daily_manual: true）。2026-11-26。
// 本番の Chatwoot・Mautic は毎日 0:00〜7:50 に止まる（cloud/README.md の 4.11）ため、それらを使うジョブを手動にした。
// 時刻はこの夜間の停止に合わせた運用の決まりで、control-plane の定義には持たせていない（変えるときは cloud の NightlyStop* と一緒に直す）

/** 人が作業してよい時刻（JST）。0:00〜7:50 の停止と、8:00 の受け付けの開始に合わせる */
export const DAILY_OPS_START_HOUR = 8;

const TOKYO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** ISO 8601 を JST の日付（YYYY-MM-DD）と時（0〜23）にする */
export function tokyoDateHour(iso: string): { date: string; hour: number } {
  const parts = Object.fromEntries(TOKYO.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** 今日（JST）の直近の実行。直近の実行が今日より前なら null */
export function todaysRun(job: JobStatus, now: string): RunRecord | null {
  if (!job.lastRun) return null;
  return tokyoDateHour(job.lastRun.startedAt).date === tokyoDateHour(now).date ? job.lastRun : null;
}

export function isNightTime(now: string): boolean {
  return tokyoDateHour(now).hour < DAILY_OPS_START_HOUR;
}

const DESCRIPTION =
  "毎朝 8:00 以降に、下のジョブを「手動で起動」で動かします。作業は 8:00〜24:00 に行ってください。夜間（0:00〜7:50）は本番の Chatwoot・Mautic が止まっていて、ジョブは失敗し、画面も開きません。";

function runHref(jobId: string): string {
  return `/runs/new?jobId=${encodeURIComponent(jobId)}`;
}

/** 夜間の注意。夜間でなければ何も出さない */
function NightAlert({ now }: { now: string }) {
  if (!isNightTime(now)) return null;
  return (
    <Alert type="warning" header="いまは夜間です">
      本番の Chatwoot・Mautic は 0:00〜7:50 に止まっています。8:00 になってから起動してください。
    </Alert>
  );
}

/**
 * 実行記録・ジョブの一覧の上に出す「毎日の運用」。daily_manual のジョブが無ければ何も出さない。
 * now はサーバーが描いた時刻（ISO 8601）。ブラウザの時計で判定すると、サーバーの描画と食い違う（水和のずれ）ため受け取る
 */
export function DailyOpsPanel({ jobs, now }: { jobs: JobStatus[]; now: string }) {
  const follow = useFollow();
  const daily = jobs.filter((job) => job.definition.dailyManual);
  if (daily.length === 0) return null;
  const done = daily.filter((job) => todaysRun(job, now)?.outcome === "success").length;

  return (
    <Table
      variant="container"
      items={daily}
      trackBy={(job) => job.definition.id}
      header={
        <SpaceBetween size="s">
          <Header variant="h2" counter={`(今日 ${done}/${daily.length} 件 成功)`} description={DESCRIPTION}>
            毎日の運用
          </Header>
          <NightAlert now={now} />
        </SpaceBetween>
      }
      columnDefinitions={[
        {
          id: "id",
          header: "ジョブ",
          cell: (job) => (
            <div>
              <Link href={`/jobs/${encodeURIComponent(job.definition.id)}`} onFollow={follow}>
                {job.definition.id}
              </Link>
              {job.definition.description ? (
                <Box variant="small" color="text-body-secondary" display="block">
                  {job.definition.description}
                </Box>
              ) : null}
            </div>
          ),
        },
        {
          id: "today",
          header: "今日の実行",
          cell: (job) => {
            const run = todaysRun(job, now);
            if (!run) return <StatusIndicator type="pending">まだ動かしていない</StatusIndicator>;
            return (
              <Link href={`/runs/${run.runId}`} onFollow={follow}>
                <SpaceBetween size="xxs" direction="horizontal">
                  <RunStatus run={run} />
                  <span>{formatTime(run.startedAt, "minute").slice(11)}</span>
                </SpaceBetween>
              </Link>
            );
          },
        },
        {
          id: "action",
          header: "操作",
          cell: (job) => (
            <Button href={runHref(job.definition.id)} onFollow={follow} ariaLabel={`${job.definition.id} を手動で起動`}>
              手動で起動
            </Button>
          ),
        },
      ]}
      wrapLines
    />
  );
}

/** ジョブの詳細に出す注意（daily_manual のジョブだけ）。夜間は warning にする */
export function DailyOpsJobAlert({ job, now }: { job: JobStatus; now: string }) {
  if (!job.definition.dailyManual) return null;
  const run = todaysRun(job, now);
  const night = isNightTime(now);
  return (
    <Alert type={night ? "warning" : "info"} header={night ? "毎日の運用のジョブです（いまは夜間です）" : "毎日の運用のジョブです"}>
      <SpaceBetween size="xs">
        <span>{DESCRIPTION}</span>
        <span>
          今日の実行:{" "}
          {run ? (
            <RunStatus run={run} />
          ) : (
            <StatusIndicator type="pending">まだ動かしていない</StatusIndicator>
          )}
        </span>
      </SpaceBetween>
    </Alert>
  );
}
