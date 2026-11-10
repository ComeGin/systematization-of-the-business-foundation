"use client";

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ButtonDropdown from "@cloudscape-design/components/button-dropdown";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { CycleRow, CycleView } from "control-plane";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatTime, useFollow } from "@/components/common/navigation";
import { InfoLink } from "@/components/layout/tools-context";
import { startCycle } from "./cycle-api";

const STUCK_LABEL = {
  no_proposal: "改修案が無い",
  pr_not_approved: "PR が未承認",
  awaiting_review: "OK 待ち",
  not_executed: "未実行",
  not_deployed: "未配信",
} as const;

/** 周の日付（期間の表示。時刻は要らない） */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 上: 周のまとめ。周の ID と期間・「改修案 n 件のうち」の内訳・キーワード由来の反映・前の周の 30 日後の判定・
 * 反映 0 件の警告・「この周を始める」。cycle が null のときは理由を出す。
 */
export function CycleSummaryHeader({
  view,
  cycles,
  current,
}: {
  view: CycleView;
  cycles: CycleRow[];
  /** 今日の周のページ。「この周を始める」はここだけに出す */
  current: boolean;
}) {
  const router = useRouter();
  const follow = useFollow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cycle, summary } = view;

  async function start() {
    setBusy(true);
    setError(null);
    const result = await startCycle();
    setBusy(false);
    if (!result.ok) setError(`周を始められませんでした: ${result.error}`);
    router.refresh();
  }

  const close = cycle?.close ?? null;
  const reflectedTotal = close ? close.reflectedFromProposals + close.reflectedFromKeywords : null;
  const stuckEntries = close ? (Object.keys(STUCK_LABEL) as (keyof typeof STUCK_LABEL)[]).filter((key) => close.stuck[key] > 0) : [];

  return (
    <Container
      header={
        <Header
          variant="h1"
          info={<InfoLink />}
          description={
            cycle
              ? `${cycle.cycleId}（${day(cycle.startsAt)} 〜 ${day(cycle.endsAt)}）${cycle.manual ? " ・ 手動で開いた周" : ""}${cycle.closedAt ? ` ・ ${formatTime(cycle.closedAt, "minute")} に締め済み` : ""}`
              : "周はまだ開かれていない"
          }
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              {cycles.length > 0 ? (
                <ButtonDropdown
                  items={[
                    { id: "/cycle", text: "今の周", href: "/cycle" },
                    ...cycles.map((row) => ({
                      id: row.cycleId,
                      text: `${row.cycleId}（${day(row.startsAt)} 〜 ${day(row.endsAt)}）`,
                      href: `/cycle/${row.cycleId}`,
                    })),
                  ]}
                  onItemFollow={follow}
                >
                  周を選ぶ
                </ButtonDropdown>
              ) : null}
              {current ? (
                <Button variant="primary" disabled={cycle !== null} loading={busy} onClick={() => void start()}>
                  この周を始める
                </Button>
              ) : null}
            </SpaceBetween>
          }
        >
          改善ループ
        </Header>
      }
    >
      <SpaceBetween size="m">
        {error ? (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}
        {view.reason ? (
          <Alert type={cycle ? "warning" : "info"} header={cycle ? "確かめる必要がある" : "周が無い理由"}>
            {view.reason}
          </Alert>
        ) : null}
        {reflectedTotal === 0 ? (
          <Alert type="warning" header="この周は反映が 0 件だった">
            改修案の反映もキーワード由来の記事の反映も無かった。止まっている項目（下の内訳）と、承認の待ちを確かめる。
          </Alert>
        ) : null}

        {cycle ? (
          <KeyValuePairs
            columns={3}
            items={[
              {
                label: "この周の改修案",
                value: (
                  <span>
                    {summary.proposals} 件のうち、反映済み {summary.reflected}・承認待ち {summary.awaiting}・差し戻し {summary.rejected}・止まっている{" "}
                    {summary.stuck}
                  </span>
                ),
              },
              { label: "キーワード由来の反映", value: `${summary.keywordReflected} 件` },
              {
                label: "前の周の 30 日後の判定",
                value:
                  view.previousVerification.length === 0 ? (
                    "なし"
                  ) : (
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {view.previousVerification.map((entry) => (
                        <li key={entry.proposalId}>
                          {entry.proposalId}: {entry.state}
                          {entry.result ? `（${entry.result}）` : ""}
                        </li>
                      ))}
                    </ul>
                  ),
              },
              ...(close
                ? [
                    {
                      label: "締めたときの止まっていたもの",
                      value: stuckEntries.length
                        ? stuckEntries.map((key) => `${STUCK_LABEL[key]} ${close.stuck[key]} 件`).join("・")
                        : "なし",
                    },
                  ]
                : []),
            ]}
          />
        ) : (
          <Box color="text-body-secondary">「この周を始める」を押すと、今日の周を手で開ける（起点を待たない）。</Box>
        )}
      </SpaceBetween>
    </Container>
  );
}
