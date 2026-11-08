"use client";

import Box from "@cloudscape-design/components/box";
import HelpPanel from "@cloudscape-design/components/help-panel";

export function AgentsListHelp() {
  return (
    <HelpPanel header={<h2>Agent</h2>}>
      <Box variant="p">
        .claude/agents/*.md の定義です。承認済みの main のチェックアウトから読むため、画面からは変えられません（ADR-18）。
        変えるときは PR を main に入れます。
      </Box>
      <h3>使うジョブ</h3>
      <Box variant="p">
        「なし（手動だけ）」の Agent は、定期実行に載っていません。管理者が「手動の起動」から指示を書いて起動します。
      </Box>
    </HelpPanel>
  );
}

export function AgentDetailHelp() {
  return (
    <HelpPanel header={<h2>Agent 1 件</h2>}>
      <Box variant="p">Agent の役割・使えるツール・使うジョブ・直近の実行と、手順（定義の本文）です。</Box>
      <h3>参照・書き込み</h3>
      <Box variant="p">
        ツールの名前と MCP の登録表（ops/mcp-registry.yaml）の access_level から決めた目安です。権限そのものは、
        定義の tools（許可リスト）と MCP サーバー側の ACCESS_LEVEL が決めます。分けられないものは「不明」と出します。
      </Box>
      <h3>中身</h3>
      <Box variant="p">
        実行が書いた観測（E-12）の取得の結果です。実行が「成功」でも、データを取れなかった観測があれば「取得に失敗」と出します。
      </Box>
    </HelpPanel>
  );
}
