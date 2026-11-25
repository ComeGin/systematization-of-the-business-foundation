// チャット（Chatwoot）のウィジェットに補う読み上げ用の名前（2026-10-18。G-2 でユーザーが決定）。
// launcher・frame は 01-content-spec.md §8.3 の既存の語（ランチャーの文言・受信箱の見出し）、close は §12 に足す語。

/** 受付時間外にチャットを開こうとしたときの案内（2026-11-25。ユーザーの決定。0〜8 時は Chatwoot を止める。01-content-spec.md §8） */
export const CHAT_CLOSED_NOTICE =
  "0時から8時まではチャットを停止しています。8時以降にお試しください。お急ぎの場合は kamegin4@comegin.com までメールでご連絡ください。";

export const CHAT_WIDGET_NAMES = {
  /** ランチャーのボタンの aria-label（SDK の既定は英語の title「Open chat window」） */
  launcher: "チャットで質問する",
  /** 開いた後にページ側に出る閉じるボタンの aria-label（SDK の既定は名前なし） */
  close: "チャットを閉じる",
  /** ウィジェットの iframe の title（SDK の既定は空） */
  frame: "ComeGin へのご質問",
} as const;
