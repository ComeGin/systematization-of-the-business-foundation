// 指（タッチ・ペン）で押している間だけ、要素に data-touch-press を付ける（2026-10-20。iPhone でも動きに触れられるようにした。05-motion-spec.md §8.4）。
// hover の無い端末で、hover の代わりの「押したら応える」に使う（Tilt3d・GlowGrid・Pin3d・ToolMarquee）。
//
// - 付けるのはマウス以外の pointerdown。離す（pointerup）で外し、スクロールが始まった（pointercancel）ときはすぐに外す。
//   iOS の Safari はスクロールが始まると pointercancel を出すので、押したまま指を動かしてスクロールしたときは、すぐに元へ戻る。
// - 素早いタップでも変化が見えるよう、付けてから holdMs（既定は --motion-duration-medium）は外さない。
//   ページを移るタップでは、移る前に一瞬だけ見えて、そのまま形のつながり（View Transitions）へ続く。
// - reduced-motion のときは何もしない（CSS 側も prefers-reduced-motion: no-preference の中でだけ変化を書く）。
// - bfcache から戻ったとき（pageshow の persisted）は外す（押した形のまま残さない）。
// - 動かしていないときは何も回らない（rAF を使わない。位置の書き込みの間引きは呼び出し側が rAF で行う）。
import { prefersReducedMotion } from "@/modules/a11y/client";
import { DURATION } from "./tokens";

export const TOUCH_PRESS = "data-touch-press";

export interface TouchPressOptions {
  /** 付けてから外さない最短の時間（ms）。既定は DURATION.medium */
  holdMs?: number;
  /** 押した位置・押したまま動かした位置（client 座標） */
  onMove?: (x: number, y: number) => void;
  /** 印を外した後（位置の CSS 変数を消すなど） */
  onRelease?: () => void;
}

/** el を押している間だけ data-touch-press を付ける。戻り値で聞くのをやめる */
export function watchTouchPress(
  el: HTMLElement,
  { holdMs = DURATION.medium, onMove, onRelease }: TouchPressOptions = {},
): () => void {
  let active = false;
  let pressedAt = 0;
  let timer = 0;

  const clear = () => {
    window.clearTimeout(timer);
    timer = 0;
    if (!el.hasAttribute(TOUCH_PRESS)) return;
    el.removeAttribute(TOUCH_PRESS);
    onRelease?.();
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || prefersReducedMotion()) return;
    window.clearTimeout(timer);
    active = true;
    pressedAt = performance.now();
    el.setAttribute(TOUCH_PRESS, "");
    onMove?.(event.clientX, event.clientY);
  };
  const move = (event: PointerEvent) => {
    if (active && event.pointerType !== "mouse")
      onMove?.(event.clientX, event.clientY);
  };
  const up = (event: PointerEvent) => {
    if (!active || event.pointerType === "mouse") return;
    active = false;
    const wait = Math.max(0, holdMs - (performance.now() - pressedAt));
    window.clearTimeout(timer);
    timer = window.setTimeout(clear, wait);
  };
  // スクロールが始まった（pointercancel）ときは待たずに戻す（スクロールの間、傾いたまま流れていかない）
  const cancel = (event: PointerEvent) => {
    if (!active || event.pointerType === "mouse") return;
    active = false;
    clear();
  };
  const show = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    active = false;
    clear();
  };

  el.addEventListener("pointerdown", down, { passive: true });
  el.addEventListener("pointermove", move, { passive: true });
  el.addEventListener("pointerup", up, { passive: true });
  el.addEventListener("pointercancel", cancel, { passive: true });
  window.addEventListener("pageshow", show);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
    window.removeEventListener("pageshow", show);
    active = false;
    clear();
  };
}
