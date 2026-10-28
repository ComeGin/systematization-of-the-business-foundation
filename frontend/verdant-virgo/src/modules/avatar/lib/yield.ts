// 模型（diorama）が見えている間、画面の端のアバターを引っ込める判定（2026-10-28。H-13。代表のアバターが同じ画面に 2 人いない）。
// ブラウザ専用。React・three に依存しない。
//   - source（模型の根の [data-avatar-yield-source]。模型の中にアバターが写るページだけ）が画面に 1px でも入っている間は yielded=true。
//   - 最初の通知（開いた時点の状態）は遅延なしで確定する（読み込みのたびに端のアバターが一瞬出て引っ込むのを避ける。最終レビュー I-2）。
//   - 2 回目以降の出入りは settleMs 続いたときだけ通知する（ヒーローの境目で素早くスクロールしても、端のアバターが点滅しない）。
//   - IntersectionObserver が無い環境では何もしない（端のアバターを隠さない）。
// どう引っ込めるか（transform とトークンのトランジション・描画の停止）は受け取る側（AvatarStage と CSS）が決める（scroll-away.ts と同じ分け方）。
import { DURATION } from "@/modules/motion/lib/tokens";

/** 出入りを確定するまでの間（ms）。--motion-duration-medium */
export const YIELD_SETTLE_MS = DURATION.medium;

export function watchYield(
  source: Element,
  onChange: (yielded: boolean) => void,
  { settleMs = YIELD_SETTLE_MS }: { settleMs?: number } = {},
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  let current = false;
  let pending: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;
  const observer = new IntersectionObserver((entries) => {
    const seen = entries.some((entry) => entry.isIntersecting);
    if (first) {
      first = false;
      if (seen !== current) {
        current = seen;
        onChange(current);
      }
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (seen === current) {
      pending = null;
      return;
    }
    pending = seen;
    timer = setTimeout(() => {
      timer = undefined;
      if (pending === null || pending === current) return;
      current = pending;
      pending = null;
      onChange(current);
    }, settleMs);
  });
  observer.observe(source);
  return () => {
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
  };
}
