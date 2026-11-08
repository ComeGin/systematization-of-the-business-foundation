"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Grid from "@cloudscape-design/components/grid";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { SetupStatusView as SetupStatusData } from "control-plane";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { formatTime } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { LevelStatus } from "./LevelStatus";
import { RunOrderPanel } from "./RunOrderPanel";
import { StepDetail } from "./StepDetail";
import { StepList } from "./StepList";
import { LEVEL_ORDER } from "./status-format";

/** 「今すぐ確かめる」のあと、結果が入れ替わるのを待つ上限（これを過ぎたら自動の読み直しをやめる） */
const WAIT_LIMIT_MS = 120_000;

/**
 * 設定の状況。上に最後の確認・次の予定・件数・「今すぐ確かめる」と実行の順番（setup/README.md の「本番の段階」）、
 * 左に段階の地図、右に選んだ段階のコマンド・止まったときの操作・項目。
 */
export function SetupStatusView({ view, selectedStepId }: { view: SetupStatusData; selectedStepId: string | null }) {
  const router = useRouter();
  // 押した時点の checkedAt。結果の checkedAt が変わるまで（または上限まで）待つ
  const [waitingFrom, setWaitingFrom] = useState<{ checkedAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const waiting = waitingFrom !== null && view.checkedAt === waitingFrom.checkedAt;
  const busy = view.running || waiting;

  useEffect(() => {
    if (!waitingFrom) return;
    const timer = setTimeout(() => setWaitingFrom(null), WAIT_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [waitingFrom]);

  async function refresh() {
    setError(null);
    try {
      const response = await fetch("/api/setup-status", { method: "POST" });
      const body = (await response.json().catch(() => null)) as { accepted?: boolean; error?: string } | null;
      if (!response.ok) {
        setError(`確認を始められませんでした（${body?.error ?? response.status}）`);
        return;
      }
      // accepted=false は確認中（二重に起動しない）。どちらも結果が入れ替わるまで読み直す
      setWaitingFrom({ checkedAt: view.checkedAt });
      router.refresh();
    } catch {
      setError("サーバーに接続できませんでした");
    }
  }

  if (!view.enabled) {
    return (
      <ContentLayout header={<Header variant="h1" info={<InfoLink />}>設定の状況</Header>}>
        <Alert type="info" header="この監視アプリでは動いていません">
          {view.reason ?? "本番の監視アプリだけで動きます"}
        </Alert>
      </ContentLayout>
    );
  }

  const selectedStep = view.steps.find((step) => step.id === selectedStepId) ?? null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          info={<InfoLink />}
          description={`最後の確認 ${formatTime(view.checkedAt)} ／ 次の予定 ${formatTime(view.nextCheckAt, "minute")}`}
          actions={
            <Button variant="primary" iconName="refresh" loading={busy} disabled={busy} loadingText="確認中" onClick={() => void refresh()}>
              今すぐ確かめる
            </Button>
          }
        >
          設定の状況
        </Header>
      }
    >
      <AutoRefresh active={busy} />
      <SpaceBetween size="l">
        {view.notifyError ? (
          <Alert type="warning" header="知らせを送れませんでした">
            {view.notifyError}
          </Alert>
        ) : null}
        {view.reason ? (
          <Alert type="warning" header="一部を確かめられていません">
            {view.reason}
          </Alert>
        ) : null}
        {error ? (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}

        <SpaceBetween direction="horizontal" size="l" alignItems="center">
          {LEVEL_ORDER.map((level) => (
            <SpaceBetween key={level} direction="horizontal" size="xxs">
              <LevelStatus level={level} />
              <Box fontWeight="bold">{view.counts[level]}</Box>
            </SpaceBetween>
          ))}
        </SpaceBetween>

        {view.guide && view.guide.runOrder.length > 0 ? <RunOrderPanel entries={view.guide.runOrder} steps={view.steps} /> : null}

        <Grid gridDefinition={[{ colspan: { default: 12, m: 5, l: 4 } }, { colspan: { default: 12, m: 7, l: 8 } }]}>
          <StepList steps={view.steps} selectedStepId={selectedStep?.id ?? null} />
          <StepDetail step={selectedStep} guide={view.guide ?? null} />
        </Grid>
      </SpaceBetween>
    </ContentLayout>
  );
}
