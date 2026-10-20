// Mobile でスクロールしている間だけ、アバターを左の画面の外へ逃がす（Task 10b。R19）。ブラウザ専用。React・three に依存しない。
// 狭い画面では、左下のアバターが本文・料金カードのボタンに重なる。読み進めている間は退き、止まってから戻る。
//   - スクロールが始まったら onChange(true)。止まって SCROLL_SETTLE_MS 経ったら onChange(false)。
//   - 止まったかは、スクロールのたびにタイマーを作り直さず、最後のスクロールの時刻を覚えて判定する（triggers.ts の idle と同じ書き方）。
//   - canHide() が偽の間（アバターのボタンにフォーカスがある）は逃がさない。逃がしている間にフォーカスが中へ来たら、すぐ戻す（2.4.7）。
// どこへ・どう動かすか（translate／transform とトークンのトランジション）と、逃がしている間の描画の停止は受け取る側（AvatarStage と CSS）が決める。
import { DURATION } from "@/modules/motion/lib/tokens";

/** スクロールが止まったと見なす間（ms）。--motion-duration-large */
export const SCROLL_SETTLE_MS = DURATION.large;

export interface ScrollAwayOptions {
  /** いま逃がしてよいか（アバターのボタンにフォーカスがあれば偽） */
  canHide: () => boolean;
  /** 逃がす（true）・戻す（false）。変わったときだけ呼ぶ */
  onChange: (away: boolean) => void;
}

/** スクロールの監視を始める。戻り値で監視をやめる */
export function watchScrollAway({
  canHide,
  onChange,
}: ScrollAwayOptions): () => void {
  let away = false;
  let lastScroll = 0;
  let timer = 0;

  const set = (next: boolean) => {
    if (next === away) return;
    away = next;
    onChange(next);
  };

  const check = () => {
    timer = 0;
    const quiet = performance.now() - lastScroll;
    if (quiet >= SCROLL_SETTLE_MS) set(false);
    else timer = window.setTimeout(check, SCROLL_SETTLE_MS - quiet);
  };

  const onScroll = () => {
    if (!canHide()) {
      set(false);
      return;
    }
    lastScroll = performance.now();
    set(true);
    if (!timer) timer = window.setTimeout(check, SCROLL_SETTLE_MS);
  };

  // a11y: 逃がしている間に Tab でアバターのボタンへ来たら、止まるのを待たずに戻す（フォーカスの見えるものを画面の外に置かない）
  const onFocusIn = () => {
    if (away && !canHide()) set(false);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("focusin", onFocusIn);
  return () => {
    window.removeEventListener("scroll", onScroll);
    document.removeEventListener("focusin", onFocusIn);
    window.clearTimeout(timer);
  };
}
