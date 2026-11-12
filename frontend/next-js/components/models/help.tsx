"use client";

import Box from "@cloudscape-design/components/box";
import HelpPanel from "@cloudscape-design/components/help-panel";

export function ModelsHelp() {
  return (
    <HelpPanel header={<h2>実行モデル</h2>}>
      <Box variant="p">
        定期実行と手動の起動で、エージェント（Anthropic）とアイキャッチ画像（OpenAI）が使うモデルを選びます。選ぶとすぐ保存され、次の実行から使われます（実行中のものは変わりません）。
      </Box>
      <h3>決まり方</h3>
      <ul>
        <li>Anthropic: Agent ごとの選択 → 全体の既定 → 定義（.claude/agents の model）→ SDK の既定の順</li>
        <li>OpenAI: 画面の選択 → 環境変数 CONTROL_OPENAI_IMAGE_MODEL（無ければ既定）の順</li>
        <li>画面の選択は、承認済み main の定義より優先します。誰が・いつ・何から何へ変えたかは「変更の履歴」に残ります</li>
      </ul>
      <h3>選べるモデル</h3>
      <ul>
        <li>各社の API（Anthropic の Models API・OpenAI の models.list）から読んだ一覧です。10 分ごとに読み直します</li>
        <li>OpenAI は画像のモデルだけを出します</li>
        <li>一覧を読めないときは変えられません（打ち間違いのモデル名で夜の実行がすべて失敗するのを防ぐため）</li>
        <li>Anthropic のエイリアス（sonnet・opus・haiku）は、監視アプリが使う Agent SDK の版が決めるモデルを指します</li>
      </ul>
      <h3>確かめ方</h3>
      <Box variant="p">実際に使ったモデルは、実行記録の詳細の「モデル」に残ります。費用は同じ画面の「費用（USD）」で比べられます。</Box>
    </HelpPanel>
  );
}
