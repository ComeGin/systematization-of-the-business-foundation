"use client";

import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { AgentInfo, JobDefinition, JobStatus, RunObservations, RunRecord } from "control-plane";
import { firstSentence, serverLabel } from "@/components/agents/agent-format";
import { AgentText } from "@/components/common/AgentText";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { describeOutcome } from "@/components/common/failure-class";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { ContentStatus } from "@/components/runs/ContentStatus";
import { ObservationsTable } from "@/components/runs/ObservationsTable";
import { RunStatus } from "@/components/runs/RunStatus";
import { RunsTable } from "@/components/runs/RunsTable";
import { dependentsOf, EnabledStatus, ioItems, jobKindLabel, NOT_WRITTEN, STAGES, stageLabel } from "./job-format";

function Lines({ value }: { value: ReturnType<typeof ioItems> }) {
  if (value.kind === "notWritten") return <span>{NOT_WRITTEN}</span>;
  if (value.kind === "none") return <span>なし</span>;
  const { items } = value;
  if (items.length === 1) return <span>{items[0]}</span>;
  return (
    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
      {items.map((item, index) => (
        // 同じ文の行が 2 つあってもキーが重ならないよう、位置を含める
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function duration(run: RunRecord): string {
  if (!run.finishedAt) return "-";
  const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 詳細: 定期実行のジョブ 1 件。① 処理の概要 ② 入出力 ③ Agent ④ 直近の結果と理由（観測の中身まで）を出す
 * （設計 docs/superpowers/specs/2026-11-06-job-agent-info-design.md の 5 節）。
 * 定義は承認済み main の ops/schedules/<id>.yaml で、画面からは変えない（ADR-18）。子リソースはこのジョブの実行記録（新しい順）。
 */
export function JobDetailView({
  job,
  jobs,
  runs,
  runLimit,
  observations,
  agent,
}: {
  job: JobStatus;
  jobs: JobDefinition[];
  runs: RunRecord[];
  runLimit: number;
  observations: Record<string, RunObservations>;
  agent: AgentInfo | null;
}) {
  const follow = useFollow();
  const { definition, lastRun } = job;
  const jobHref = (id: string) => `/jobs/${encodeURIComponent(id)}`;
  const jobLinks = (ids: string[]) =>
    ids.length ? (
      <SpaceBetween size="xxs" direction="horizontal">
        {ids.map((id) => (
          <Link key={id} href={jobHref(id)} onFollow={follow}>
            {id}
          </Link>
        ))}
      </SpaceBetween>
    ) : (
      "なし"
    );
  const lastObservations = lastRun ? observations[lastRun.runId] : undefined;

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
        <Container header={<Header variant="h2">① 処理の概要</Header>}>
          <SpaceBetween size="s">
            <Box variant="p">
              <span style={{ whiteSpace: "pre-wrap" }}>{definition.overview ?? NOT_WRITTEN}</span>
            </Box>
            <Box variant="small" color="text-body-secondary">
              改善ループの中の段階:{" "}
              {definition.stage
                ? STAGES.map((stage) => (
                    <span key={stage} style={{ marginInlineEnd: 4 }}>
                      {stage === definition.stage ? <Badge color="blue">{stageLabel(stage)}</Badge> : stageLabel(stage)}
                    </span>
                  ))
                : NOT_WRITTEN}
            </Box>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">② 入出力</Header>}>
          <KeyValuePairs
            columns={2}
            items={[
              { label: "読むもの", value: <Lines value={ioItems(definition.io, "reads")} /> },
              { label: "書くもの", value: <Lines value={ioItems(definition.io, "writes")} /> },
              { label: "書かないもの", value: <Lines value={ioItems(definition.io, "doesNotWrite")} /> },
              {
                label: "待つもの（after）／待たれるもの",
                value: (
                  <SpaceBetween size="xxs">
                    <span>待つ: {jobLinks(definition.after)}</span>
                    <span>待たれる: {jobLinks(dependentsOf(definition.id, jobs))}</span>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        </Container>

        <Container
          header={
            <Header variant="h2" description={`承認済み main の ops/schedules/${definition.id}.yaml（画面からは変えません）`}>
              定義
            </Header>
          }
        >
          <SpaceBetween size="m">
            <KeyValuePairs
              columns={3}
              items={[
                { label: "有効", value: <EnabledStatus enabled={definition.enabled} /> },
                { label: "種類", value: jobKindLabel(definition) },
                { label: "cron（Asia/Tokyo）", value: definition.cron },
                { label: "上限の秒数", value: definition.timeoutSec },
                { label: "最大ターン数", value: definition.maxTurns ?? "-" },
                { label: "次回", value: formatTime(job.nextRunAt, "minute") },
              ]}
            />
            {definition.prompt ? (
              <ExpandableSection headerText="Agent への指示（yaml の prompt）を見る">
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{definition.prompt}</pre>
              </ExpandableSection>
            ) : null}
          </SpaceBetween>
        </Container>

        {definition.kind === "agent" ? (
          <Container header={<Header variant="h2">③ Agent</Header>}>
            {agent ? (
              <SpaceBetween size="xs">
                <Box>
                  <Link href={`/agents/${encodeURIComponent(agent.name)}`} onFollow={follow}>
                    {agent.name}
                  </Link>{" "}
                  — {firstSentence(agent.description) || NOT_WRITTEN}
                </Box>
                <Box variant="small" color="text-body-secondary">
                  接続先: {agent.toolGroups.length ? agent.toolGroups.map((group) => serverLabel(group)).join("・") : "なし"}
                </Box>
              </SpaceBetween>
            ) : (
              <Box color="text-status-warning">Agent の定義が見つからない（{definition.agent}）</Box>
            )}
          </Container>
        ) : null}

        <Container header={<Header variant="h2">④ 直近の結果と理由</Header>}>
          {lastRun ? (
            <SpaceBetween size="m">
              <KeyValuePairs
                columns={4}
                items={[
                  {
                    label: "実行",
                    value: (
                      <Link href={`/runs/${lastRun.runId}`} onFollow={follow}>
                        <RunStatus run={lastRun} />
                      </Link>
                    ),
                  },
                  { label: "中身", value: <ContentStatus observations={lastObservations} /> },
                  { label: "開始・所要時間", value: `${formatTime(lastRun.startedAt)}（${duration(lastRun)}）` },
                  { label: "費用（USD）", value: lastRun.costUsd === null ? "-" : lastRun.costUsd.toFixed(4) },
                  {
                    label: "失敗の分類",
                    value: lastRun.failureClass
                      ? `${lastRun.failureClass}（${describeOutcome(lastRun.failureClass).meaning}）`
                      : "-",
                  },
                  { label: "見送りの理由", value: lastRun.skipReason ?? "-" },
                ]}
              />
              <Box>
                <Box variant="awsui-key-label">Agent の要約</Box>
                <AgentText text={lastRun.summary} />
              </Box>
              <ObservationsTable
                title="この実行が書いた観測"
                description="取得の結果と、エージェントが書いた理由"
                observations={lastObservations?.written ?? []}
                empty="この実行が書いた観測はありません"
              />
            </SpaceBetween>
          ) : (
            <Box color="text-body-secondary">まだ実行されていません</Box>
          )}
        </Container>

        <RunsTable
          variant="container"
          runs={runs}
          observations={observations}
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
