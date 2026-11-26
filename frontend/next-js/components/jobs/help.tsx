"use client";

import Box from "@cloudscape-design/components/box";
import HelpPanel from "@cloudscape-design/components/help-panel";

export function JobsListHelp() {
  return (
    <HelpPanel header={<h2>定期実行のジョブ</h2>}>
      <Box variant="p">
        ops/schedules/*.yaml の定義です。承認済みの main のチェックアウトから読むため、画面からは変えられません（ADR-18）。
        変えるときは PR を main に入れます。
      </Box>
      <h3>種類</h3>
      <ul>
        <li>agent: エージェント（.claude/agents）を Agent SDK で起動する</li>
        <li>builtin: 監視アプリ自身が実行する決まった処理（heartbeat・runlog-flush など）</li>
      </ul>
      <h3>毎日の運用</h3>
      <Box variant="p">
        一覧の上の「毎日の運用」は、定義に daily_manual: true が付いたジョブ（夜間に本番の Chatwoot・Mautic が止まるため手動にしたもの）です。毎朝 8:00
        以降に「手動で起動」で動かします。作業は 8:00〜24:00 に行います。「今日の実行」は、そのジョブの直近の実行が今日（JST）のものかで判定します。
      </Box>
      <h3>定期実行の有効・無効</h3>
      <Box variant="p">
        CONTROL_SCHEDULER_ENABLED=false（開発の既定）のときは次回の予定が出ません。手動の起動とハートビートは動きます。
      </Box>
    </HelpPanel>
  );
}

export function JobDetailHelp() {
  return (
    <HelpPanel header={<h2>ジョブ 1 件</h2>}>
      <Box variant="p">定期実行の定義 1 件と、そのジョブの実行記録（新しい順。最大 50 件）です。</Box>
      <h3>項目</h3>
      <ul>
        <li>cron: Asia/Tokyo で評価します</li>
        <li>after: 先に成功している必要があるジョブ。未達なら見送りになります</li>
        <li>上限の秒数を超えると打ち切り、失敗（timeout）になります</li>
      </ul>
      <h3>毎日の運用</h3>
      <Box variant="p">
        上の「毎日の運用のジョブです」は、定義に daily_manual: true が付いたジョブ（夜間に本番の Chatwoot・Mautic が止まるため手動にしたもの）です。毎朝 8:00
        以降に「手動で起動」で動かします。作業は 8:00〜24:00 に行います。「今日の実行」は、そのジョブの直近の実行が今日（JST）のものかで判定します。
      </Box>
    </HelpPanel>
  );
}
