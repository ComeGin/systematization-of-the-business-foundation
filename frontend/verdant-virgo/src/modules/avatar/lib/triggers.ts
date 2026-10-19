// アバターの合図（AvatarTrigger）の検知（設計書 §7.2・§9）。ブラウザ専用。React・three に依存しない。
// ページの側は印（data-avatar-cue・data-cta-id）を置くだけで、avatar を呼ばない。forms も avatar を直接呼ばず、document にイベントを出すだけ（§9）。
//   arrive         … 監視を始めたとき（＝アバターが出たとき）。完了画面（[data-avatar-cue="form-success"]）では代わりに form-success
//   reach-pricing  … A（vivid）だけ。料金・プランの節（[data-avatar-cue="pricing"]）が画面に入ったとき。受理されるのは 1 ページ 1 回
//   cta-intent     … CTA（[data-cta-id]）にポインターが乗った・フォーカスが入ったとき
//   form-success   … forms が document に出す comegin:form-success（無料 DL の送信の成功。Task 11）
//   idle           … A（vivid）だけ。ポインター・スクロール・キーの操作が IDLE_AFTER_MS の間無いとき（その後も IDLE_AFTER_MS ごと）
// 出してよいか（一時停止・たたんだ・画面外・再生中）とエモートの選び方は受け取る側（AvatarStage とスケジューラー）が決め、受理したかを返す。
// 受理されなかった合図は消費しない（R18）: 料金の節は受理されるまで見張り続け、画面にある間は RETRY_MS ごとに出し直す。
// idle も、受理されるまで（操作が無い限り）RETRY_MS ごとに出し直す。arrive・cta-intent・form-success はその時の 1 回だけ。
import type { LiveZone } from "@/modules/motion/client";
import { IDLE_AFTER_MS } from "./emotes";
import type { AvatarTrigger } from "./types";

/** 料金・プランの節が「入った」とみなす位置（画面の下 25% を除いた範囲に掛かったら） */
const PRICING_ROOT_MARGIN = "0px 0px -25% 0px";
/** 受理されなかった料金の節・idle を出し直す間（ms） */
const RETRY_MS = 1_000;
/** 何もしていないかを見る操作 */
const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "wheel",
  "scroll",
  "keydown",
  "touchstart",
] as const;

// 送り手の正本は forms/lib/events.ts（analytics を引き込むので import しない。値の一致は tests/modules/forms/events.test.ts で見る）
export const FORM_SUCCESS_EVENT = "comegin:form-success";

const ctaOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest("[data-cta-id]") : null;

/** 合図の監視を始める。戻り値で監視をやめる */
export function watchTriggers(
  zone: LiveZone,
  emit: (t: AvatarTrigger) => boolean,
): () => void {
  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof DocumentEventMap>(
    type: K | string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ) => {
    document.addEventListener(type, handler, options);
    cleanups.push(() => document.removeEventListener(type, handler, options));
  };

  // 着いた（完了画面では、着いたことが送信できたことを表す）
  emit(
    document.querySelector('[data-avatar-cue="form-success"]')
      ? "form-success"
      : "arrive",
  );

  // 料金・プランの節（受理されたら見張りをやめる。1 ページ 1 回）。
  // A（vivid）だけ見張る（idle と同じ）。B（calm）のエモートの表に reach-pricing は無く、受理されない合図を出し直し続けるため
  const pricing =
    zone === "vivid"
      ? [...document.querySelectorAll('[data-avatar-cue="pricing"]')]
      : [];
  if (pricing.length > 0 && typeof IntersectionObserver !== "undefined") {
    let retry = 0;
    let done = false;
    const tryPricing = () => {
      retry = 0;
      if (done) return;
      if (emit("reach-pricing")) {
        done = true;
        observer.disconnect();
      } else {
        retry = window.setTimeout(tryPricing, RETRY_MS);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        window.clearTimeout(retry);
        retry = 0;
        if (entries.some((entry) => entry.isIntersecting)) tryPricing();
      },
      { rootMargin: PRICING_ROOT_MARGIN },
    );
    for (const el of pricing) observer.observe(el);
    cleanups.push(() => {
      observer.disconnect();
      window.clearTimeout(retry);
    });
  }

  // CTA に触れた。pointerenter は泡立たないので、document の捕捉の段で受ける
  listen(
    "pointerenter",
    (event) => {
      if (ctaOf(event.target)) emit("cta-intent");
    },
    { capture: true, passive: true },
  );
  listen("focusin", (event) => {
    if (ctaOf(event.target)) emit("cta-intent");
  });

  // 送信できた（ページを移らない無料 DL）
  listen(FORM_SUCCESS_EVENT, () => emit("form-success"));

  // しばらく何もしていない（A だけ）。操作のたびにタイマーを作り直さず、最後の操作の時刻だけを覚えて、満ちたら出す。
  // 受理されたら次は IDLE_AFTER_MS の後、受理されなければ（操作が無い限り）RETRY_MS の後に出し直す
  if (zone === "vivid") {
    let lastActivity = performance.now();
    let timer = 0;
    const touch = () => {
      lastActivity = performance.now();
    };
    const check = () => {
      const quiet = performance.now() - lastActivity;
      if (quiet >= IDLE_AFTER_MS) {
        if (emit("idle")) {
          lastActivity = performance.now();
          timer = window.setTimeout(check, IDLE_AFTER_MS);
        } else {
          timer = window.setTimeout(check, RETRY_MS);
        }
      } else {
        timer = window.setTimeout(check, IDLE_AFTER_MS - quiet);
      }
    };
    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, touch, { passive: true, capture: true });
      cleanups.push(() =>
        window.removeEventListener(type, touch, { capture: true }),
      );
    }
    timer = window.setTimeout(check, IDLE_AFTER_MS);
    cleanups.push(() => window.clearTimeout(timer));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
