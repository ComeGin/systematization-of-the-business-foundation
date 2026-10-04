"use client";

import Header from "@cloudscape-design/components/header";
import Table from "@cloudscape-design/components/table";
import type { MiswriteCandidate } from "control-plane";

/** 誤った書き込みの候補。メッセージの本文は保存していない。ID から Chatwoot の管理画面で確かめる。 */
export function CandidatesTable({ candidates }: { candidates: MiswriteCandidate[] }) {
  return (
    <Table
      variant="container"
      header={
        <Header
          counter={`(${candidates.length})`}
          description="エージェント専用ユーザーの送信のうち、どの E-13 にも実行記録にも対応しないもの。会話の属性（担当者・ラベル・状態）の変更は拾えません"
        >
          誤った書き込みの候補
        </Header>
      }
      items={candidates}
      trackBy="messageId"
      empty="候補はありません"
      columnDefinitions={[
        { id: "conversation", header: "会話（#番号）", cell: (c) => c.conversationDisplayId },
        { id: "message", header: "メッセージ ID", cell: (c) => c.messageId },
        { id: "sentAt", header: "送信時刻", cell: (c) => c.sentAt.slice(0, 19).replace("T", " ") },
        { id: "run", header: "近い実行", cell: (c) => c.nearestRunId ?? "-" },
        { id: "reason", header: "理由", cell: (c) => c.reason },
      ]}
    />
  );
}
