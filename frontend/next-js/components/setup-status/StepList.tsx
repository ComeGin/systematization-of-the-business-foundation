"use client";

import Header from "@cloudscape-design/components/header";
import Table from "@cloudscape-design/components/table";
import type { SetupStatusStepView } from "control-plane";
import { useRouter } from "next/navigation";
import { LevelStatus } from "./LevelStatus";
import { stepHref } from "./status-format";

/** 左: 段階の地図（P1〜P15 と R1）。段階ごとに、その中で最も重い判定の印を出す。選ぶと ?step= を書き換える。 */
export function StepList({ steps, selectedStepId }: { steps: SetupStatusStepView[]; selectedStepId: string | null }) {
  const router = useRouter();
  const selected = steps.filter((step) => step.id === selectedStepId);

  return (
    <Table
      variant="container"
      header={<Header variant="h2" counter={`(${steps.length})`}>段階</Header>}
      items={steps}
      trackBy="id"
      selectionType="single"
      selectedItems={selected}
      onSelectionChange={({ detail }) => {
        const next = detail.selectedItems[0];
        if (next) router.replace(stepHref(next.id), { scroll: false });
      }}
      onRowClick={({ detail }) => router.replace(stepHref(detail.item.id), { scroll: false })}
      ariaLabels={{
        selectionGroupLabel: "段階の選択",
        itemSelectionLabel: (_selection, item) => `${item.id} ${item.title}`,
        allItemsSelectionLabel: () => "段階",
        tableLabel: "段階の一覧",
      }}
      columnDefinitions={[
        { id: "status", header: "状態", cell: (step) => <LevelStatus level={step.level} />, width: 150 },
        { id: "step", header: "段階", cell: (step) => `${step.id} ${step.title}` },
      ]}
      empty="段階がありません"
    />
  );
}
