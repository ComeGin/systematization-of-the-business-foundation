"use client";

import Header from "@cloudscape-design/components/header";
import type { MiswriteCandidate } from "control-plane";
import { InfoLink } from "@/components/layout/tools-context";
import { CandidatesTable } from "./CandidatesTable";

/** 一覧: 誤った書き込みの候補（control-plane が返した順のまま）。 */
export function CandidatesListView({ candidates }: { candidates: MiswriteCandidate[] }) {
  return (
    <CandidatesTable
      variant="full-page"
      candidates={candidates}
      header={
        <Header
          variant="awsui-h1-sticky"
          counter={`(${candidates.length})`}
          info={<InfoLink />}
          description="エージェント専用ユーザーの送信のうち、どの E-13 にも実行記録にも対応しないもの。会話の属性（担当者・ラベル・状態）の変更は拾えません"
        >
          誤った書き込みの候補
        </Header>
      }
    />
  );
}
