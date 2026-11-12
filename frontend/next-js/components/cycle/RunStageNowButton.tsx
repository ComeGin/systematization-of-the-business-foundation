"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator, { type StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import type { CycleStage, CycleStageRun } from "control-plane";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatTime, useFollow } from "@/components/common/navigation";
import { CYCLE_STAGE_LABEL } from "@/components/layout/labels";
import { runStageNow } from "./cycle-api";

type JobState = CycleStageRun["jobs"][number];

const OUTCOME_LABEL: Record<NonNullable<JobState["outcome"]>, { type: StatusIndicatorProps.Type; text: string }> = {
  success: { type: "success", text: "成功" },
  partial: { type: "warning", text: "一部" },
  failure: { type: "error", text: "失敗" },
  skipped: { type: "stopped", text: "見送り" },
};

function jobStatus(job: JobState): { type: StatusIndicatorProps.Type; text: string } {
  if (job.state === "waiting") return { type: "pending", text: "待ち" };
  if (job.state === "running") return { type: "in-progress", text: "実行中" };
  if (job.state === "not_run") return { type: "stopped", text: "起動しなかった" };
  return job.outcome ? OUTCOME_LABEL[job.outcome] : { type: "info", text: "終わった" };
}

/** 段階の「今すぐ実行」の進み具合（ジョブごとの状態と、実行の詳細へのリンク） */
export function StageRunProgress({ run }: { run: CycleStageRun }) {
  const follow = useFollow();
  return (
    <SpaceBetween size="xs">
      <Box variant="small" color="text-body-secondary">
        {formatTime(run.startedAt, "minute")} に手動で起動（{run.actor}）
        {run.finishedAt ? `・${formatTime(run.finishedAt, "minute")} に終わった` : "・実行中（5 秒ごとに読み直す）"}
      </Box>
      {run.stoppedReason ? <Alert type="warning">{run.stoppedReason}</Alert> : null}
      <ol style={{ margin: 0, paddingInlineStart: 20 }}>
        {run.jobs.map((job) => {
          const status = jobStatus(job);
          return (
            <li key={job.jobId}>
              <SpaceBetween size="xs" direction="horizontal">
                <span>{job.jobId}</span>
                <StatusIndicator type={status.type}>{status.text}</StatusIndicator>
                {job.runId ? (
                  <Link href={`/runs/${job.runId}`} onFollow={follow} variant="secondary">
                    実行の詳細
                  </Link>
                ) : null}
              </SpaceBetween>
            </li>
          );
        })}
      </ol>
    </SpaceBetween>
  );
}

/**
 * 段階（①〜⑦）のジョブを、定期実行の時刻を待たずに今すぐ起動する（2026-11-12）。
 * サーバーが段階のジョブを決めた順に 1 本ずつ起動し、前が終わってから次を起動する。押すと確認を出す（起動する順を見せる）。
 */
export function RunStageNowButton({ stage, jobIds, running }: { stage: CycleStage; jobIds: string[]; running: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const response = await runStageNow(stage);
    setBusy(false);
    if (!response.ok) {
      setError(`起動できませんでした: ${response.error}`);
      return;
    }
    if (!response.body.accepted) {
      setError(`起動しませんでした: ${response.body.reason ?? "理由不明"}`);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button
        iconName="caret-right-filled"
        disabled={running || jobIds.length === 0}
        disabledReason={running ? "この段階は実行中です" : "この段階には定期実行のジョブがありません（人が行う段階）"}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        この段階を今すぐ実行
      </Button>
      <Modal
        visible={open}
        onDismiss={() => (busy ? undefined : setOpen(false))}
        header={`${CYCLE_STAGE_LABEL[stage]} を今すぐ実行する`}
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button variant="link" disabled={busy} onClick={() => setOpen(false)}>
                キャンセル
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void run()}>
                実行する
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          {error ? <Alert type="error">{error}</Alert> : null}
          <Box>次の順に、1 本ずつ本番の設定で起動します（前のジョブが終わってから次を起動します）。</Box>
          <ol style={{ margin: 0, paddingInlineStart: 20 }}>
            {jobIds.map((id) => (
              <li key={id}>
                <Box variant="code">{id}</Box>
              </li>
            ))}
          </ol>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>定期実行の時刻・先に終わっている必要があるジョブ（after）・周の何日目か・無効（enabled: false）の条件は見ません。前の段階の結果がそろってから押してください。</li>
            <li>エージェントのジョブは API の費用がかかります。全部終わるまで数十分かかることがあります。</li>
            <li>同じジョブが実行中なら、そのジョブは見送りになり次へ進みます。監視アプリを起動し直すと、残りのジョブは起動されません。</li>
          </ul>
        </SpaceBetween>
      </Modal>
    </>
  );
}
