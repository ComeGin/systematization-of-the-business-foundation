"use client";

import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { RunOutcome, RunRecord } from "control-plane";
import { useRouter } from "next/navigation";
import { AutoRefresh } from "@/components/common/AutoRefresh";
import { useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { RunsTable } from "./RunsTable";

const OUTCOME_OPTIONS: SelectProps.Option[] = [
  { value: "", label: "すべての状態" },
  { value: "success", label: "成功" },
  { value: "partial", label: "一部のみ" },
  { value: "failure", label: "失敗" },
  { value: "skipped", label: "見送り" },
];

function runsHref(query: { outcome: RunOutcome | null; before?: string }): string {
  const params = new URLSearchParams();
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.before) params.set("before", query.before);
  const search = params.toString();
  return search ? `/runs?${search}` : "/runs";
}

/**
 * 一覧: 実行記録（E-15）。新しい順に 1 ページずつ（相関 ID の before でさかのぼる）。
 * 最新のページで実行中の記録があれば、自動で読み直す。
 */
export function RunsListView({
  runs,
  outcome,
  before,
  hasOlder,
  pageSize,
}: {
  runs: RunRecord[];
  outcome: RunOutcome | null;
  before: string | null;
  hasOlder: boolean;
  pageSize: number;
}) {
  const router = useRouter();
  const follow = useFollow();
  const oldest = runs.at(-1);
  return (
    <>
      <AutoRefresh active={before === null && runs.some((run) => run.status === "running")} />
      <RunsTable
        variant="full-page"
        runs={runs}
        empty={outcome ? "条件に合う実行記録はありません" : undefined}
        header={
          <Header
            variant="awsui-h1-sticky"
            counter={`(${runs.length})`}
            info={<InfoLink />}
            description={`新しい順に ${pageSize} 件ずつ。${before ? "古い記録をさかのぼって表示しています" : "最新のページです"}`}
            actions={
              <SpaceBetween size="xs" direction="horizontal">
                <Select
                  selectedOption={OUTCOME_OPTIONS.find((option) => option.value === (outcome ?? "")) ?? OUTCOME_OPTIONS[0]}
                  onChange={({ detail }) =>
                    router.push(runsHref({ outcome: (detail.selectedOption.value || null) as RunOutcome | null }))
                  }
                  options={OUTCOME_OPTIONS}
                  ariaLabel="状態で絞り込む"
                />
                {before ? (
                  <Button href={runsHref({ outcome })} onFollow={follow}>
                    最新に戻る
                  </Button>
                ) : null}
                <Button
                  href={oldest ? runsHref({ outcome, before: oldest.runId }) : undefined}
                  onFollow={follow}
                  disabled={!hasOlder || !oldest}
                >
                  さらに古い記録
                </Button>
                <Button variant="primary" href="/runs/new" onFollow={follow}>
                  手動で起動
                </Button>
              </SpaceBetween>
            }
          >
            実行記録（E-15）
          </Header>
        }
      />
    </>
  );
}
