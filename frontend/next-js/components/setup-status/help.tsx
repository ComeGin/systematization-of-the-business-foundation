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
        <li>上: 最後の確認・次の予定・件数。「今すぐ確かめる」で確認を始めます（確認中は押せません）</li>
        <li>
          実行の順番: setup/README.md の「本番の段階」のコマンドを上から順に並べたものです。行ごとに、進める段階とその状態が出ます。
          「次に行う」は、更新が必要か確かめられない段階がある最初の行です（--check の行は除く）。段階を押すと右に移ります
        </li>
        <li>左: 段階の地図。段階の印は、その中の項目で最も重いものです。選ぶと URL の ?step= が変わります</li>
        <li>
          右: 選んだ段階の「コマンドと止まったとき」と項目。項目には状態・だれが・止まる id・根拠が出ます。行を開くと、
          止まったときの操作（setup/manual-steps.md の早見表の行）と、正本の手順書の節をその場で読めます。
          止まる id の案内がある「更新が必要」の項目は、最初から開いています
        </li>
      </ul>
      <h3>止まったとき</h3>
      <ul>
        <li>終了コード 3（画面での操作が必要: …（id））: 表示された手順を行い、同じコマンドを実行し直します。済んだ手順は飛ばします</li>
        <li>終了コード 1（失敗）: 理由を直してから、表示された「続きから実行する」のコマンド（--from &lt;モジュールの id&gt;）を実行します</li>
        <li>何も変えずに状態だけを見るときは、コマンドの末尾に --check を付けます</li>
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
        手順書・実行の順番・早見表は、承認済みの main のチェックアウトから読みます（ADR-18）。作業ツリーで書き換えただけのものは出ません。
        本文の中の相対パスはリンクにせず、文字で示します。
      </Box>
    </HelpPanel>
  );
}
