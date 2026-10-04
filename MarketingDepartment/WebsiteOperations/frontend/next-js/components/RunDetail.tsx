"use client";

import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import type { RunRecord } from "control-plane";
import { AutoRefresh } from "./AutoRefresh";
import { RunStatus, runLabel } from "./RunStatus";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}

/** 実行 1 件（E-15）。残っているのは要約・対象の ID・成否・起動の種類・費用だけ（ツールの結果は残さない）。 */
export function RunDetail({ run }: { run: RunRecord }) {
  return (
    <Container header={<Header variant="h2">{run.runId}</Header>}>
      <AutoRefresh active={run.status === "running"} />
      <ColumnLayout columns={3} variant="text-grid">
        <Field label="状態">
          <RunStatus run={run} />
        </Field>
        <Field label="対象">{runLabel(run)}</Field>
        <Field label="起動">{run.trigger}</Field>
        <Field label="開始">{run.startedAt}</Field>
        <Field label="終了">{run.finishedAt ?? "-"}</Field>
        <Field label="失敗分類">{run.failureClass ?? "-"}</Field>
        <Field label="SDK の結果">{run.sdkSubtype ?? "-"}</Field>
        <Field label="費用（USD）">{run.costUsd === null ? "-" : run.costUsd.toFixed(4)}</Field>
        <Field label="S3 の写し">{run.copiedAt ?? (run.status === "running" ? "-" : "未送")}</Field>
        <Field label="要約">
          {run.summary ?? "-"}
          {run.summaryRedacted ? "（個人情報の形を伏せ字にしました）" : ""}
        </Field>
        <Field label="見送りの理由">{run.skipReason ?? "-"}</Field>
        <Field label="対象の ID">{run.targetIds.length ? run.targetIds.join(", ") : "-"}</Field>
      </ColumnLayout>
    </Container>
  );
}
