"use client";

import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import CopyToClipboard from "@cloudscape-design/components/copy-to-clipboard";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Link from "@cloudscape-design/components/link";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import type { SetupRunOrderEntry, SetupStatusStepView } from "control-plane";
import { useRouter } from "next/navigation";
import { LevelStatus } from "./LevelStatus";
import { isCheckCommand, nextRunEntryId, runEntryStepId, stepHref, stepRangeLabel } from "./status-format";

/** コマンド 1 つ（コピーできる）。 */
export function CommandText({ command }: { command: string }) {
  return (
    <CopyToClipboard
      variant="inline"
      textToCopy={command}
      copyButtonAriaLabel={`コマンドをコピー: ${command}`}
      copySuccessText="コピーしました"
      copyErrorText="コピーできませんでした"
    />
  );
}

/**
 * 上: 実行の順番（setup/README.md の「本番の段階」のコマンドの並び）。行ごとに、進める段階とその状態を出し、
 * 「更新が必要」「確かめられない」がある最初の行に「次に行う」を付ける。段階を押すと右の項目に移る。
 */
export function RunOrderPanel({ entries, steps }: { entries: SetupRunOrderEntry[]; steps: SetupStatusStepView[] }) {
  const router = useRouter();
  const nextId = nextRunEntryId(entries);
  const rows = entries.map((entry, index) => ({ ...entry, order: index + 1 }));

  return (
    <ExpandableSection
      variant="container"
      defaultExpanded
      headerText="実行の順番"
      headerDescription="setup/README.md の「本番の段階」。止まったら案内に従って操作し、同じコマンドを実行し直す（済んだ手順は飛ばして続きから進む）"
    >
      <Table
        variant="embedded"
        items={rows}
        trackBy="id"
        ariaLabels={{ tableLabel: "実行の順番" }}
        columnDefinitions={[
          { id: "order", header: "順", cell: (row) => row.order, width: 56 },
          {
            id: "status",
            header: "状態",
            width: 170,
            cell: (row) => (
              <SpaceBetween size="xxs">
                {row.level ? <LevelStatus level={row.level} /> : <Box color="text-body-secondary">—</Box>}
                {row.id === nextId ? <Badge color="blue">次に行う</Badge> : null}
              </SpaceBetween>
            ),
          },
          {
            id: "command",
            header: "コマンド",
            cell: (row) =>
              row.command === null ? (
                <Badge color="grey">人の手順</Badge>
              ) : (
                <SpaceBetween size="xxs">
                  <CommandText command={row.command} />
                  {isCheckCommand(row.command) ? (
                    <Box variant="small" color="text-body-secondary">
                      確かめるだけ（何も変えない）
                    </Box>
                  ) : null}
                </SpaceBetween>
              ),
          },
          { id: "note", header: "すること", cell: (row) => row.note },
          {
            id: "steps",
            header: "段階",
            width: 110,
            cell: (row) => {
              const target = runEntryStepId(row.steps, steps);
              if (!target) return <Box color="text-body-secondary">—</Box>;
              const href = stepHref(target);
              return (
                <Link
                  href={href}
                  onFollow={(event) => {
                    event.preventDefault();
                    router.replace(href, { scroll: false });
                  }}
                >
                  {stepRangeLabel(row.steps)}
                </Link>
              );
            },
          },
        ]}
        empty="実行の順番がありません（承認済み main のカタログが古い）"
      />
    </ExpandableSection>
  );
}
