"use client";

import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import TextContent from "@cloudscape-design/components/text-content";
import type { MiswriteCandidate, RunObservations, RunRecord } from "control-plane";
import { describeOutcome } from "@/components/common/failure-class";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { CandidatesTable } from "@/components/miswrite-candidates/CandidatesTable";
import { ContentStatus } from "./ContentStatus";
import { ObservationsTable } from "./ObservationsTable";
import { RunStatus, runLabel } from "./RunStatus";
import { TRIGGER_LABEL } from "./RunsTable";

/**
 * 詳細: 実行 1 件（E-15）。残っているのは要約・対象の ID・成否・起動の種類・費用だけ（ツールの結果は残さない）。
 * 子リソースは「この実行が書いた観測」「対象にした（読んだ）観測」「対象の ID」と「この実行に近い誤った書き込みの候補」。
 */
export function RunDetailView({
  run,
  candidates,
  observations,
}: {
  run: RunRecord;
  candidates: MiswriteCandidate[];
  observations: RunObservations | null;
}) {
  const follow = useFollow();
  const target = run.jobId ? (
    <Link href={`/jobs/${encodeURIComponent(run.jobId)}`} onFollow={follow}>
      {runLabel(run)}
    </Link>
  ) : (
    runLabel(run)
  );

  return (
    <ContentLayout
      header={
        <Header variant="h1" info={<InfoLink />} description={runLabel(run)}>
          {run.runId}
        </Header>
      }
    >
      <AutoRefresh active={run.status === "running"} />
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">概要</Header>}>
          <KeyValuePairs
            columns={3}
            items={[
              { label: "状態", value: <RunStatus run={run} /> },
              { label: "中身", value: <ContentStatus observations={observations ?? undefined} /> },
              { label: "対象", value: target },
              { label: "起動", value: TRIGGER_LABEL[run.trigger] },
              { label: "開始", value: formatTime(run.startedAt) },
              { label: "終了", value: formatTime(run.finishedAt) },
              {
                label: "失敗分類",
                value: run.failureClass ? `${run.failureClass}（${describeOutcome(run.failureClass).meaning}）` : "-",
              },
              { label: "SDK の結果", value: run.sdkSubtype ?? "-" },
              { label: "費用（USD）", value: run.costUsd === null ? "-" : run.costUsd.toFixed(4) },
              { label: "モデル", value: run.model ?? "-" },
              { label: "S3 の写し", value: run.copiedAt ? formatTime(run.copiedAt) : run.status === "running" ? "-" : "未送" },
            ]}
          />
        </Container>

        <Container header={<Header variant="h2">要約</Header>}>
          <TextContent>
            {run.skipReason ? (
              <p>
                <strong>見送りの理由:</strong> {run.skipReason}
              </p>
            ) : null}
            <p style={{ whiteSpace: "pre-wrap" }}>{run.summary ?? (run.status === "running" ? "実行中です" : "要約はありません")}</p>
            {run.summaryRedacted ? (
              <p>
                <small>個人情報の形の文字列を伏せ字にしました。</small>
              </p>
            ) : null}
          </TextContent>
        </Container>

        <ObservationsTable
          title="この実行が書いた観測"
          description="観測（E-12）の fetch.correlation_id がこの実行の相関 ID と一致するもの。「中身」はこれで決める"
          observations={observations?.written ?? []}
          empty="この実行が書いた観測はありません"
        />

        <ObservationsTable
          title="この実行が対象にした（読んだ）観測"
          description="対象の ID にある観測で、この実行が書いたものでないもの。「中身」には数えない"
          observations={observations?.referenced ?? []}
          empty="対象にした観測はありません"
        />

        <Table
          variant="container"
          header={
            <Header variant="h2" counter={`(${run.targetIds.length})`} description="E-09 の id、E-10 の display_id、E-04 の documentId など">
              対象の ID
            </Header>
          }
          items={run.targetIds.map((id) => ({ id }))}
          trackBy="id"
          empty={<Box color="text-body-secondary">触れた対象はありません</Box>}
          columnDefinitions={[{ id: "id", header: "ID", cell: (item) => item.id }]}
        />

        <CandidatesTable
          variant="container"
          candidates={candidates}
          header={
            <Header variant="h2" counter={`(${candidates.length})`} description="送信時刻の前後でこの実行が見つかった候補">
              誤った書き込みの候補
            </Header>
          }
          empty="この実行に近い候補はありません"
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
