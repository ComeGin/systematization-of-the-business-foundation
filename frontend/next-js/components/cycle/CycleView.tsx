"use client";

import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Grid from "@cloudscape-design/components/grid";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import type { CycleRow, CycleStage, CycleView as CycleViewData, JobDefinition } from "control-plane";
import { useState } from "react";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { formatTime, useFollow } from "@/components/common/navigation";
import {
  CYCLE_ITEM_KIND_LABEL,
  CYCLE_ITEM_STATE_LABEL,
  CYCLE_ITEM_STATE_TYPE,
  CYCLE_STAGE_LABEL,
  CYCLE_STAGE_STATUS_LABEL,
  CYCLE_STAGE_STATUS_TYPE,
} from "@/components/layout/labels";
import { CycleItemPanel } from "./CycleItemPanel";
import { CycleStageNav } from "./CycleStageNav";
import { CycleSummaryHeader } from "./CycleSummaryHeader";

type Item = CycleViewData["items"][number];

/** 最初に開く段階: 承認待ちがあればその段階、止まっているものがあればその段階、なければ先頭 */
function initialStage(stages: CycleViewData["stages"]): CycleStage | null {
  return (stages.find((s) => s.status === "awaiting") ?? stages.find((s) => s.status === "stuck") ?? stages[0])?.stage ?? null;
}

/** 右: 選んだ段階の概要（その段階のジョブが何を作るか。ジョブ詳細へのリンク）と、項目の一覧 */
function StagePanel({
  stage,
  stageInfo,
  jobs,
  items,
  selectedId,
  onSelectItem,
}: {
  stage: CycleStage;
  stageInfo: CycleViewData["stages"][number];
  jobs: JobDefinition[];
  items: Item[];
  selectedId: string | null;
  onSelectItem: (itemId: string | null) => void;
}) {
  const follow = useFollow();
  const stageJobs = stageInfo.jobIds.map((id) => ({ id, definition: jobs.find((job) => job.id === id) ?? null }));
  const selected = items.find((item) => item.itemId === selectedId) ?? null;

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            counter={`(${stageInfo.count})`}
            actions={
              <StatusIndicator type={CYCLE_STAGE_STATUS_TYPE[stageInfo.status]}>{CYCLE_STAGE_STATUS_LABEL[stageInfo.status]}</StatusIndicator>
            }
          >
            {CYCLE_STAGE_LABEL[stage]}
          </Header>
        }
      >
        {stageJobs.length === 0 ? (
          <Box color="text-body-secondary">この段階に結びつく定期実行のジョブはありません（人が行う段階）</Box>
        ) : (
          <SpaceBetween size="s">
            {stageJobs.map(({ id, definition }) => (
              <div key={id}>
                <Link href={`/jobs/${encodeURIComponent(id)}`} onFollow={follow}>
                  {id}
                </Link>
                {definition?.description ? (
                  <Box variant="small" color="text-body-secondary" display="block">
                    {definition.description}
                  </Box>
                ) : null}
                {definition?.overview ? (
                  <ExpandableSection variant="footer" headerText="処理の概要">
                    <span style={{ whiteSpace: "pre-wrap" }}>{definition.overview}</span>
                  </ExpandableSection>
                ) : null}
              </div>
            ))}
          </SpaceBetween>
        )}
      </Container>

      <Table
        variant="container"
        header={<Header variant="h2" counter={`(${items.length})`}>この段階の項目</Header>}
        items={items}
        trackBy="itemId"
        selectionType="single"
        selectedItems={selected ? [selected] : []}
        onSelectionChange={({ detail }) => onSelectItem(detail.selectedItems[0]?.itemId ?? null)}
        ariaLabels={{
          selectionGroupLabel: "項目の選択",
          itemSelectionLabel: ({ selectedItems }, item) => `${item.title}${selectedItems.includes(item) ? "（選択中）" : ""}`,
        }}
        empty="この段階の項目はまだありません"
        columnDefinitions={[
          {
            id: "title",
            header: "項目",
            cell: (item) => (
              <Button variant="inline-link" onClick={() => onSelectItem(item.itemId === selectedId ? null : item.itemId)}>
                {item.title}
              </Button>
            ),
          },
          { id: "kind", header: "種類", cell: (item) => CYCLE_ITEM_KIND_LABEL[item.kind] },
          {
            id: "state",
            header: "状態",
            cell: (item) => <StatusIndicator type={CYCLE_ITEM_STATE_TYPE[item.state]}>{CYCLE_ITEM_STATE_LABEL[item.state]}</StatusIndicator>,
          },
          { id: "updated", header: "更新", cell: (item) => formatTime(item.updatedAt, "minute") },
        ]}
        wrapLines
      />

      {selected ? <CycleItemPanel key={`${selected.itemId}:${selected.updatedAt}`} item={selected} /> : null}
    </SpaceBetween>
  );
}

/**
 * 改善ループ（レイアウト A）。上に周のまとめ、左に段階 ①〜⑦、右に選んだ段階の概要と項目、項目を開くと承認の画面。
 * 30 秒ごとに読み直す（「実行した」の後の確かめの結果を拾うため）。
 * 設計 docs/superpowers/specs/2026-11-09-improvement-cycle-design.md の 5.5 節。
 */
export function CycleView({
  view,
  jobs,
  cycles,
  current,
}: {
  view: CycleViewData;
  jobs: JobDefinition[];
  cycles: CycleRow[];
  current: boolean;
}) {
  const [stage, setStage] = useState<CycleStage | null>(() => initialStage(view.stages));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stageInfo = view.stages.find((entry) => entry.stage === stage) ?? null;

  return (
    <ContentLayout>
      <AutoRefresh active intervalMs={30_000} />
      <SpaceBetween size="l">
        <CycleSummaryHeader view={view} cycles={cycles} current={current} />
        {stage && stageInfo ? (
          <Grid gridDefinition={[{ colspan: { default: 12, m: 4, l: 3 } }, { colspan: { default: 12, m: 8, l: 9 } }]}>
            <CycleStageNav
              stages={view.stages}
              selected={stage}
              onSelect={(next) => {
                setStage(next);
                setSelectedId(null);
              }}
            />
            <StagePanel
              stage={stage}
              stageInfo={stageInfo}
              jobs={jobs}
              items={view.items.filter((item) => item.stage === stage)}
              selectedId={selectedId}
              onSelectItem={setSelectedId}
            />
          </Grid>
        ) : null}
      </SpaceBetween>
    </ContentLayout>
  );
}
