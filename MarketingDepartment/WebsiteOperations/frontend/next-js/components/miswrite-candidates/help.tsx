"use client";

import Box from "@cloudscape-design/components/box";
import HelpPanel from "@cloudscape-design/components/help-panel";

export function MiswriteCandidatesHelp() {
  return (
    <HelpPanel header={<h2>誤った書き込みの候補</h2>}>
      <Box variant="p">
        Chatwoot のエージェント専用ユーザーの送信のうち、どの E-13 にも実行記録にも対応しないものです（builtin の
        miswrite-check が見つけます）。
      </Box>
      <h3>確かめ方</h3>
      <ul>
        <li>メッセージの本文は保存していません。会話の番号（display_id）から Chatwoot の管理画面で確かめます</li>
        <li>「近い実行」は送信時刻の前後で見つかった実行です。無ければ「-」</li>
      </ul>
      <h3>拾えないもの</h3>
      <Box variant="p">会話の属性（担当者・ラベル・状態）の変更は拾えません。</Box>
    </HelpPanel>
  );
}
