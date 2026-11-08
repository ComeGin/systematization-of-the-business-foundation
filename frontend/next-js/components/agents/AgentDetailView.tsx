"use client";

import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import ContentLayout from "@cloudscape-design/components/content-layout";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import TextContent from "@cloudscape-design/components/text-content";
import type { AgentInfo, JobStatus, RunObservations, RunRecord, ToolAccess } from "control-plane";
import { Markdown } from "@/components/common/Markdown";
import { useFollow } from "@/components/common/navigation";
import { EnabledStatus } from "@/components/jobs/job-format";
import { InfoLink } from "@/components/layout/tools-context";
import { RunsTable } from "@/components/runs/RunsTable";
import { serverLabel, shortToolName, toolAccessLabel } from "./agent-format";

const ACCESS_COLOR: Record<ToolAccess, "red" | "grey" | "blue"> = { write: "red", read: "grey", unknown: "blue" };

/**
 * 詳細: Agent 1 件。定義は承認済み main の .claude/agents/<name>.md で、画面からは変えない（ADR-18）。
 * 子リソースは「使うジョブ」と「直近の実行（中身つき）」。
 */
export function AgentDetailView({
  agent,
  jobs,
  recentRuns,
  observations,
}: {
  agent: AgentInfo;
  jobs: JobStatus[];
  recentRuns: RunRecord[];
  observations: Record<string, RunObservations>;
}) {
  const follow = useFollow();
  return (
    <ContentLayout
      header={
        <Header variant="h1" info={<InfoLink />} description={`承認済み main の .claude/agents/${agent.name}.md（画面からは変えません）`}>
          {agent.name}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">役割</Header>}>
          <SpaceBetween size="s">
            <Box variant="p">{agent.description || "（定義に書かれていない）"}</Box>
            <KeyValuePairs
              columns={2}
              items={[
                { label: "モデル", value: agent.model ?? "-" },
                { label: "使えないツール（disallowedTools）", value: agent.disallowedTools.length ? agent.disallowedTools.join(", ") : "-" },
              ]}
            />
          </SpaceBetween>
        </Container>

        <Container
          header={
            <Header variant="h2" description="ツールの名前と登録表の access_level から決めた目安です。書き込みは赤で出します">
              接続先とツール
            </Header>
          }
        >
          {agent.toolGroups.length === 0 ? (
            <Box color="text-body-secondary">ツールが定義されていません</Box>
          ) : (
            <ColumnLayout columns={2} variant="text-grid">
              {agent.toolGroups.map((group) => (
                <SpaceBetween key={group.server ?? "builtin"} size="xs">
                  <Box variant="h3">
                    {serverLabel(group)} {group.accessLevel ? <Badge color="grey">{group.accessLevel}</Badge> : null}
                  </Box>
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {group.tools.map((tool) => (
                      <li key={tool.name}>
                        <Badge color={ACCESS_COLOR[tool.access]}>{toolAccessLabel(group.server, tool.access)}</Badge> <code>{shortToolName(tool.name)}</code>
                      </li>
                    ))}
                  </ul>
                </SpaceBetween>
              ))}
            </ColumnLayout>
          )}
        </Container>

        <Table
          variant="container"
          header={
            <Header variant="h2" counter={`(${jobs.length})`} description="この Agent を起動する定期実行のジョブ">
              使うジョブ
            </Header>
          }
          items={jobs}
          trackBy={(job) => job.definition.id}
          empty={<Box color="text-body-secondary">なし（手動の起動だけで使う）</Box>}
          columnDefinitions={[
            {
              id: "id",
              header: "ID",
              cell: (job) => (
                <Link href={`/jobs/${encodeURIComponent(job.definition.id)}`} onFollow={follow}>
                  {job.definition.id}
                </Link>
              ),
            },
            { id: "cron", header: "cron（Asia/Tokyo）", cell: (job) => job.definition.cron },
            { id: "enabled", header: "有効", cell: (job) => <EnabledStatus enabled={job.definition.enabled} /> },
          ]}
        />

        <RunsTable
          variant="container"
          runs={recentRuns}
          observations={observations}
          empty="この Agent の直近の実行はありません"
          header={
            <Header variant="h2" counter={`(${recentRuns.length})`} description="使うジョブの記録と手動の起動を合わせた新しい順（最大 5 件。手動の起動は実行記録の新しい 50 件から探す）">
              直近の実行
            </Header>
          }
        />

        <Container header={<Header variant="h2">手順（定義の本文）</Header>}>
          {agent.body ? (
            <TextContent>
              <Markdown>{agent.body}</Markdown>
            </TextContent>
          ) : (
            <Box color="text-body-secondary">本文がありません</Box>
          )}
        </Container>
      </SpaceBetween>
    </ContentLayout>
  );
}
