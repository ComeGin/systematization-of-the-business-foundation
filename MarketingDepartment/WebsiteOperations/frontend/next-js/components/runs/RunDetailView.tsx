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
import type { MiswriteCandidate, RunRecord } from "control-plane";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { CandidatesTable } from "@/components/miswrite-candidates/CandidatesTable";
import { RunStatus, runLabel } from "./RunStatus";
import { TRIGGER_LABEL } from "./RunsTable";

/**
 * 詳細: 実行 1 件（E-15）。残っているのは要約・対象の ID・成否・起動の種類・費用だけ（ツールの結果は残さない）。
 * 子リソースは「対象の ID」と「この実行に近い誤った書き込みの候補」。
 */
export function RunDetailView({ run, candidates }: { run: RunRecord; candidates: MiswriteCandidate[] }) {
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
              { label: "対象", value: target },
              { label: "起動", value: TRIGGER_LABEL[run.trigger] },
              { label: "開始", value: formatTime(run.startedAt) },
              { label: "終了", value: formatTime(run.finishedAt) },
              { label: "失敗分類", value: run.failureClass ?? "-" },
              { label: "SDK の結果", value: run.sdkSubtype ?? "-" },
              { label: "費用（USD）", value: run.costUsd === null ? "-" : run.costUsd.toFixed(4) },
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
