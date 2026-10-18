// チャット（Chatwoot）のウィジェットに補う読み上げ用の名前（2026-10-18。G-2 でユーザーが決定）。
// launcher・frame は 01-content-spec.md §8.3 の既存の語（ランチャーの文言・受信箱の見出し）、close は §12 に足す語。

export const CHAT_WIDGET_NAMES = {
  /** ランチャーのボタンの aria-label（SDK の既定は英語の title「Open chat window」） */
  launcher: "チャットで質問する",
  /** 開いた後にページ側に出る閉じるボタンの aria-label（SDK の既定は名前なし） */
  close: "チャットを閉じる",
  /** ウィジェットの iframe の title（SDK の既定は空） */
  frame: "ComeGin へのご質問",
} as const;
