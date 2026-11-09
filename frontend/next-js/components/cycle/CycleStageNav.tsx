"use client";

import Badge from "@cloudscape-design/components/badge";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { CycleStage, CycleView } from "control-plane";
import { CYCLE_STAGE_LABEL, CYCLE_STAGE_STATUS_LABEL, CYCLE_STAGE_STATUS_TYPE } from "@/components/layout/labels";

const HREF_PREFIX = "#stage-";

/**
 * 左: 段階 ①〜⑦ の縦の一覧。段階ごとに状態（済み・承認待ち・未着手・止まっている）と項目の件数を出す。
 * 押すと右にその段階の概要と項目が出る（ページの移動はしない）。
 */
export function CycleStageNav({
  stages,
  selected,
  onSelect,
}: {
  stages: CycleView["stages"];
  selected: CycleStage;
  onSelect: (stage: CycleStage) => void;
}) {
  return (
    <SideNavigation
      header={{ text: "段階", href: `${HREF_PREFIX}${selected}` }}
      activeHref={`${HREF_PREFIX}${selected}`}
      onFollow={(event) => {
        event.preventDefault();
        const stage = event.detail.href.slice(HREF_PREFIX.length) as CycleStage;
        if (stages.some((entry) => entry.stage === stage)) onSelect(stage);
      }}
      items={stages.map((entry) => ({
        type: "link" as const,
        text: CYCLE_STAGE_LABEL[entry.stage],
        href: `${HREF_PREFIX}${entry.stage}`,
        info: (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <StatusIndicator type={CYCLE_STAGE_STATUS_TYPE[entry.status]}>{CYCLE_STAGE_STATUS_LABEL[entry.status]}</StatusIndicator>
            <Badge>{entry.count} 件</Badge>
          </span>
        ),
      }))}
    />
  );
}
