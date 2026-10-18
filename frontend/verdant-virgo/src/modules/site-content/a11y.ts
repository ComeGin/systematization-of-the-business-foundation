// 読み上げ用の文言（sr-only・aria-label・title）。正本は 01-content-spec.md §12（2026-10-18 に G-1 で承認）。
// 部品の既定値に入れず、ここから渡す（03-handoff.md H-16・H-31）。ほかのモジュールもここから import してよい。

/** S-2 target="_blank" のすべてのリンクの末尾に置く sr-only（a11y の NewTabNotice の text） */
export const NEW_TAB_NOTICE = "（新しいタブで開きます）";

/**
 * S-3 サービスのカードの「詳しく見る」の末尾に置く sr-only（ServiceCard の detailTarget）。
 * 読み上げは「詳しく見る：環境構築」。区切りの全角のコロンもここで持つ（部品は足さない）。
 */
export const detailLinkTarget = (cardHeading: string) => `：${cardHeading}`;

/** S-4 Spinner を単独で使うときの名前。reduced-motion のときは見える文字としても出す */
export const LOADING_LABEL = "読み込み中";

/** S-11 MotionPause（トップの 1-11 の CTA バナーの右下）の見える文字（＝名前） */
export const MOTION_PAUSE = {
  pause: "動きを止める",
  resume: "動きを再開する",
} as const;
