import type { ReactNode } from "react";

/** 新しいタブで開くリンクに添える告知。文言は site-content/a11y.ts の NEW_TAB_NOTICE を渡す */
export interface NewTabNoticeProps {
  text: string;
}

/** 画面には出さず、支援技術にだけ読ませる文 */
export interface VisuallyHiddenProps {
  as?: "span" | "div" | "p";
  id?: string;
  children: ReactNode;
}

/**
 * 5 秒を超えて自動で動く部品の一時停止ボタン（WCAG 2.2.2）。
 * 計画書の契約（label 1 つ）を、名前を「一時停止」⇔「再開」で入れ替えるために 2 つに分けた（2026-10-18 承認）。
 */
export interface MotionPauseProps {
  /** 動いている間の名前（押すと止まる） */
  pauseLabel: string;
  /** 止まっている間の名前（押すと動く） */
  resumeLabel: string;
  /** 押したとき（と、sessionStorage から止めた状態を戻したとき）に呼ぶ */
  onToggle(paused: boolean): void;
  /** sessionStorage のキー。ページを移っても止まったままにする（動きの規則 3） */
  storageKey: string;
  /** 置く面。dark は反転面（navy.700）の上 */
  tone?: "light" | "dark";
  className?: string;
}
