"use client";

import Box from "@cloudscape-design/components/box";
import HelpPanel from "@cloudscape-design/components/help-panel";

export function RunsListHelp() {
  return (
    <HelpPanel header={<h2>実行記録（E-15）</h2>}>
      <Box variant="p">
        監視アプリが起動したエージェントと builtin の処理の記録です。正本はオンプレの SQLite で、S3 には写しだけを送ります。
      </Box>
      <h3>残しているもの</h3>
      <ul>
        <li>要約・触れた対象の ID・成否・起動の種類・費用だけ</li>
        <li>MCP のツールの結果（顧客のデータ）は残しません。中身は ID から各製品の管理画面で確かめます</li>
      </ul>
      <h3>状態</h3>
      <ul>
        <li>成功 / 一部のみ（truncated などで一部が欠けた）/ 失敗 / 見送り（前回が実行中・after の未達など）</li>
        <li>実行中の記録があるあいだ、最新のページは数秒ごとに読み直します</li>
      </ul>
    </HelpPanel>
  );
}

export function RunsNewHelp() {
  return (
    <HelpPanel header={<h2>手動の起動</h2>}>
      <Box variant="p">
        サーバーが Agent SDK でエージェントを起動します。ブラウザから Claude Code を直接は呼ばず、経過と結果だけが返ります。
      </Box>
      <h3>指定のしかた</h3>
      <ul>
        <li>エージェントを指定: .claude/agents/&lt;名前&gt;.md の名前とプロンプト</li>
        <li>定期実行の定義を指定: ops/schedules の id。無効（enabled: false）の定義も手動なら起動できます</li>
      </ul>
      <h3>注意</h3>
      <ul>
        <li>定義は承認済みの main のチェックアウトから読みます（ADR-18）。作業ツリーの変更は効きません</li>
        <li>プロンプトに個人情報（氏名・メールアドレス）を書かないでください</li>
        <li>前回が実行中などで起動しなかったときも、見送りの記録が作られます</li>
      </ul>
    </HelpPanel>
  );
}

export function RunDetailHelp() {
  return (
    <HelpPanel header={<h2>実行 1 件</h2>}>
      <Box variant="p">実行記録（E-15）の 1 件です。相関 ID は E-12・E-13 に埋め込まれます。</Box>
      <h3>項目</h3>
      <ul>
        <li>失敗分類: DD-01 の 4.2 の 9 値</li>
        <li>S3 の写し: 起動時・10 分ごと・各実行の終了時に、未送のものを自動で再送します</li>
        <li>要約: 記録の前に、メールアドレスや電話番号の形の文字列を伏せ字にします</li>
      </ul>
      <h3>子リソース</h3>
      <ul>
        <li>対象の ID: 触れた E-09・E-10・E-04 などの ID</li>
        <li>誤った書き込みの候補: 送信時刻の前後でこの実行が見つかったもの</li>
      </ul>
    </HelpPanel>
  );
}
