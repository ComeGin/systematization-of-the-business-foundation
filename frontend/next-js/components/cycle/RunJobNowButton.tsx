"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFollow } from "@/components/common/navigation";
import { runJobNow } from "./cycle-api";

type Result = { runId: string; accepted: boolean };

/**
 * 段階のジョブ 1 本を、定期実行の時刻を待たずに今すぐ起動する（手動の起動。/runs/new の「定期実行の定義を指定」と同じ）。
 * 押すと確認を出し、受け付けたらその実行へのリンクを出す（画面は移らない。30 秒ごとの読み直しで段階の項目が増える）。
 * 手動の起動は after（先に終わっている必要があるジョブ）と周の何日目の条件を見ないので、確認でそれを伝える。
 * 同じジョブが実行中なら見送り（skipped の記録）になる。
 */
export function RunJobNowButton({ jobId, enabled }: { jobId: string; enabled: boolean }) {
  const router = useRouter();
  const follow = useFollow();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const response = await runJobNow(jobId);
    setBusy(false);
    if (!response.ok) {
      setError(`起動できませんでした: ${response.error}`);
      return;
    }
    setResult(response.body);
    setOpen(false);
    router.refresh();
  }

  return (
    <SpaceBetween size="xs">
      <Button
        iconName="caret-right-filled"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        ariaLabel={`${jobId} を今すぐ実行`}
      >
        今すぐ実行
      </Button>

      {result ? (
        <Alert type={result.accepted ? "success" : "warning"} dismissible onDismiss={() => setResult(null)}>
          {result.accepted ? "起動しました。" : "見送りました（前回が実行中、または設定が無いなど。理由は実行の要約に出ます）。"}{" "}
          <Link href={`/runs/${result.runId}`} onFollow={follow}>
            実行の詳細を見る
          </Link>
        </Alert>
      ) : null}
      {error && !open ? (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      ) : null}

      <Modal
        visible={open}
        onDismiss={() => (busy ? undefined : setOpen(false))}
        header="今すぐ実行する"
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
          <Box>
            <Box variant="code">{jobId}</Box> を、定期実行の時刻を待たずに本番の設定で起動します。
          </Box>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>先に終わっている必要があるジョブ（after）と、周の何日目に動かすかの条件は見ません。前の段階の結果がそろっているか確かめてから押してください。</li>
            <li>エージェントのジョブは API の費用がかかります。同じジョブが実行中なら見送りになります。</li>
            {enabled ? null : <li>この定義は無効（enabled: false）です。自動では動きませんが、手動なら起動できます。</li>}
          </ul>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
