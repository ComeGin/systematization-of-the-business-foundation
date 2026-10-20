/**
 * 利用者の「視差効果を減らす」設定（prefers-reduced-motion: reduce）の判定。ブラウザ側だけで呼ぶ。
 * CSS の側は global.css が transition・animation を 0.01ms にする（計画書 P-5）。
 * JS で動かすもの（WebGL・requestAnimationFrame・gsap など）は、ここで判定して静止させる（P-6）。
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function mediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia(QUERY);
}

/** 動きを減らす設定なら true。matchMedia が使えない環境では false（設定が表明されていないものとして扱う） */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

/** 設定の変化を受け取る。戻り値で購読をやめる */
export function onReducedMotionChange(
  callback: (reduced: boolean) => void,
): () => void {
  const mql = mediaQuery();
  if (!mql) return () => {};
  const listener = (event: MediaQueryListEvent) => callback(event.matches);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}
