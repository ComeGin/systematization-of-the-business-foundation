"use client";

import Link from "@cloudscape-design/components/link";
import Table, { type TableProps } from "@cloudscape-design/components/table";
import type { MiswriteCandidate } from "control-plane";
import { formatTime, useFollow } from "@/components/common/navigation";

/**
 * 誤った書き込みの候補の表。一覧の画面（full-page）と、実行の詳細の子リソース（container）で使う。
 * メッセージの本文は保存していない。ID から Chatwoot の管理画面で確かめる。
 */
export function CandidatesTable({
  candidates,
  header,
  variant,
  empty = "候補はありません",
}: {
  candidates: MiswriteCandidate[];
  header: React.ReactNode;
  variant: TableProps.Variant;
  empty?: React.ReactNode;
}) {
  const follow = useFollow();
  return (
    <Table
      variant={variant}
      stickyHeader={variant === "full-page"}
      header={header}
      items={candidates}
      trackBy="messageId"
      empty={empty}
      columnDefinitions={[
        { id: "conversation", header: "会話（#番号）", cell: (c) => c.conversationDisplayId },
        { id: "message", header: "メッセージ ID", cell: (c) => c.messageId },
        { id: "sentAt", header: "送信時刻", cell: (c) => formatTime(c.sentAt) },
        {
          id: "run",
          header: "近い実行",
          cell: (c) =>
            c.nearestRunId ? (
              <Link href={`/runs/${c.nearestRunId}`} onFollow={follow}>
                {c.nearestRunId}
              </Link>
            ) : (
              "-"
            ),
        },
        { id: "reason", header: "理由", cell: (c) => c.reason },
      ]}
    />
  );
}
