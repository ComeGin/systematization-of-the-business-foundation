"use client";

import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import Table from "@cloudscape-design/components/table";
import type { ObservationSummary } from "control-plane";
import { AgentText } from "@/components/common/AgentText";
import { describeOutcome } from "@/components/common/failure-class";

/** 観測（E-12）ごとの取得の結果と理由。理由はエージェントが書いた文なので文字のまま出す */
export function ObservationsTable({
  title,
  description,
  observations,
  empty,
}: {
  title: string;
  description?: string;
  observations: ObservationSummary[];
  empty: string;
}) {
  return (
    <Table
      variant="container"
      header={
        <Header variant="h2" counter={`(${observations.length})`} description={description}>
          {title}
        </Header>
      }
      items={observations}
      trackBy="auditId"
      empty={<Box color="text-body-secondary">{empty}</Box>}
      wrapLines
      columnDefinitions={[
        { id: "auditId", header: "観測", cell: (o) => o.auditId },
        {
          id: "outcome",
          header: "取得の結果",
          cell: (o) => {
            if (!o.found) return <StatusIndicator type="warning">見つからない</StatusIndicator>;
            const outcome = describeOutcome(o.outcome);
            return (
              <div>
                <StatusIndicator type={outcome.ok ? "success" : "error"}>
                  {o.outcome ?? "-"}（{outcome.label}）
                </StatusIndicator>
                <Box variant="small" color="text-body-secondary">
                  {outcome.meaning}
                </Box>
              </div>
            );
          },
        },
        { id: "note", header: "理由（エージェントが書いた文）", cell: (o) => <AgentText text={o.note} /> },
        { id: "createdBy", header: "書いた Agent", cell: (o) => o.createdBy ?? "-" },
        { id: "measuredAt", header: "取得の時刻", cell: (o) => o.measuredAt ?? "-" },
      ]}
    />
  );
}
