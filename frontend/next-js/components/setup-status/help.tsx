"use client";

import Box from "@cloudscape-design/components/box";
import HelpPanel from "@cloudscape-design/components/help-panel";

export function SetupStatusHelp() {
  return (
    <HelpPanel header={<h2>設定の状況</h2>}>
      <Box variant="p">
        本番の設定の手順（setup/00-setup-overview.md の P1〜P15 と R1）が、いま済んでいるかを一覧にしたものです。
        本番の監視アプリだけで動き、定期的に確かめた結果を出します（CONTROL_SETUP_STATUS_ENABLED=true）。
      </Box>
      <h3>画面の見かた</h3>
      <ul>
        <li>左: 段階の地図。段階の印は、その中の項目で最も重いものです。選ぶと URL の ?step= が変わります</li>
        <li>右: 選んだ段階の項目。状態・だれが・止まる id・根拠が出ます。行を開くと、正本の手順書の節をその場で読めます</li>
        <li>上: 最後の確認・次の予定・件数。「今すぐ確かめる」で確認を始めます（確認中は押せません）</li>
      </ul>
      <h3>状態の印</h3>
      <ul>
        <li>済み: 確かめて問題なし</li>
        <li>更新が必要: 人が対応する。止まる id は setup/manual-steps.md の早見表で引けます</li>
        <li>警告: 動いているが気をつける点がある</li>
        <li>確かめられない: AWS に届かない・時間切れ・資格情報が無いなど。理由は根拠に出ます</li>
        <li>人が確かめる: 自動では確かめられない（未検査・申告・判断）</li>
      </ul>
      <h3>手順書の本文</h3>
      <Box variant="p">
        承認済みの main のチェックアウトから読みます（ADR-18）。作業ツリーで書き換えただけの手順書は出ません。
        本文の中の相対パスはリンクにせず、文字で示します。
      </Box>
    </HelpPanel>
  );
}
