"use client";

import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { SetupStatusItemView, SetupStatusStepView } from "control-plane";
import { useState } from "react";
import { formatTime } from "@/components/common/navigation";
import { DocSection } from "./DocSection";
import { LevelStatus } from "./LevelStatus";

/** 項目の見出しの横に出すもの: 状態・だれが・止まる id・確かめた時刻 */
function ItemMeta({ item }: { item: SetupStatusItemView }) {
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <LevelStatus level={item.level} />
      <Box color="text-body-secondary">{item.who}</Box>
      {item.stopId ? <Box variant="code">{item.stopId}</Box> : null}
      {item.checkedAt ? <Box color="text-body-secondary">確かめた時刻 {formatTime(item.checkedAt, "minute")}</Box> : null}
    </SpaceBetween>
  );
}

/** 項目 1 件。正本の節があれば、開いたときにその場で本文を読んで描く。 */
function ItemCard({ item }: { item: SetupStatusItemView }) {
  const [expanded, setExpanded] = useState(false);

  if (item.docs.length === 0) {
    return (
      <Container header={<Header variant="h3" info={<ItemMeta item={item} />} description={item.evidence}>{item.title}</Header>} />
    );
  }
  return (
    <ExpandableSection
      variant="container"
      headerText={item.title}
      headerInfo={<ItemMeta item={item} />}
      headerDescription={item.evidence}
      expanded={expanded}
      onChange={({ detail }) => setExpanded(detail.expanded)}
    >
      {/* 開いたときだけ読む（閉じている項目のために API を呼ばない） */}
      {expanded ? (
        <SpaceBetween size="m">
          {item.docs.map((doc) => (
            <DocSection key={`${doc.file}#${doc.heading}`} file={doc.file} heading={doc.heading} />
          ))}
        </SpaceBetween>
      ) : null}
    </ExpandableSection>
  );
}

/** 右: 選んだ段階の項目。 */
export function StepDetail({ step }: { step: SetupStatusStepView | null }) {
  if (!step) return <Container header={<Header variant="h2">項目</Header>}>左の一覧から段階を選んでください。</Container>;
  return (
    <SpaceBetween size="m">
      <Header variant="h2" counter={`(${step.items.length})`} info={<LevelStatus level={step.level} />}>
        {step.id} {step.title}
      </Header>
      {step.items.length === 0 ? <Box color="text-body-secondary">この段階に項目はありません</Box> : null}
      {step.items.map((item) => (
        <ItemCard key={item.id} item={item} />
      ))}
    </SpaceBetween>
  );
}
