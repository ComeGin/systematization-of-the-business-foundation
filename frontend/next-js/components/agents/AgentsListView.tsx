"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import type { AgentListing } from "control-plane";
import { useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { firstSentence } from "./agent-format";

/** 一覧: Agent。定義は承認済み main のチェックアウトから読んだもの（画面からは変えない）。 */
export function AgentsListView({ listing }: { listing: AgentListing }) {
  const follow = useFollow();
  return (
    <SpaceBetween size="l">
      {listing.errors.length > 0 ? (
        <Alert type="warning" header={`読めない定義が ${listing.errors.length} 件あります`}>
          <ul>
            {listing.errors.map((error) => (
              <li key={error.file}>
                {error.file}: {error.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Table
        variant="full-page"
        stickyHeader
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={`(${listing.agents.length})`}
            info={<InfoLink />}
            description="承認済み main の .claude/agents/*.md（画面からは変えません）"
          >
            Agent
          </Header>
        }
        items={listing.agents}
        trackBy="name"
        wrapLines
        empty={<Box color="text-body-secondary">Agent の定義がありません</Box>}
        columnDefinitions={[
          {
            id: "name",
            header: "名前",
            cell: (agent) => (
              <Link href={`/agents/${encodeURIComponent(agent.name)}`} onFollow={follow}>
                {agent.name}
              </Link>
            ),
          },
          { id: "role", header: "役割", cell: (agent) => firstSentence(agent.description) || "-" },
          {
            id: "jobs",
            header: "使うジョブ",
            cell: (agent) => (agent.jobIds.length === 0 ? "なし（手動だけ）" : `${agent.jobIds.length} 本`),
          },
        ]}
      />
    </SpaceBetween>
  );
}
