// アバターの枠の拡大・縮小（2026-10-20 の裁定 R20）。ブラウザ専用。React・three に依存しない。
//   - ホイール: 上へ回すと大きく、下へ回すと小さく。端（ZOOM_MIN・ZOOM_MAX か画面の大きさ）まで来たら、ページのスクロールに譲る（preventDefault しない）。
//   - トラックパッドのピンチ（ctrlKey 付きの wheel）: 同じく拡大・縮小。端でもページの拡大にはしない（アバターの上のピンチはアバターのもの）。
//   - タッチのピンチ: 1 本目の指がアバターの上で始まったら、2 本目はどこに置いてもよい（小さいアバターの上に 2 本の指を収めなくてよい）。
// 大きさの反映（CSS の scale・描画の解像度・記憶）と、画面からはみ出さない上限は受け取る側（AvatarStage）が決める。
// キーボード（＋・−・0）は AvatarStage のボタンが受ける（2.1.1）。

export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 2;
/** キーボードの 1 回の倍率 */
export const ZOOM_STEP = 1.2;

/** ホイールの 1px あたりの変化（指数）。マウスの 1 目盛り（100px）で約 0.82 倍・1.22 倍 */
const WHEEL_RATE = 0.002;
/** トラックパッドのピンチの 1px あたり（ctrlKey 付きの wheel は小さい値で来るので大きく取る） */
const PINCH_WHEEL_RATE = 0.01;
/** deltaMode が行（1）のときの 1 行の px */
const LINE_PX = 16;

/** 拡大率を範囲に収める。max は画面の大きさから求めた上限（ZOOM_MIN を下回っても ZOOM_MIN は許す） */
export function clampZoom(zoom: number, max = ZOOM_MAX): number {
  const upper = Math.max(ZOOM_MIN, Math.min(max, ZOOM_MAX));
  return Math.min(Math.max(zoom, ZOOM_MIN), upper);
}

export interface ZoomOptions {
  /** いまの拡大率 */
  get: () => number;
  /** 拡大率を変える（clampZoom で収めた値を渡す） */
  set: (zoom: number) => void;
  /** いまの画面で許す上限 */
  max: () => number;
  /** タッチのピンチを始めた（true）・終えた（false）。指に合わせて動かす間はトランジションを外すため */
  onPinch?: (active: boolean) => void;
}

/** el（アバター本体のボタン）でホイールとピンチを受け始める。戻り値でやめる */
export function watchZoom(
  el: HTMLElement,
  { get, set, max, onPinch }: ZoomOptions,
): () => void {
  const onWheel = (event: WheelEvent) => {
    const unit =
      event.deltaMode === 1
        ? LINE_PX
        : event.deltaMode === 2
          ? window.innerHeight
          : 1;
    const rate = event.ctrlKey ? PINCH_WHEEL_RATE : WHEEL_RATE;
    const current = get();
    const next = clampZoom(
      current * Math.exp(-event.deltaY * unit * rate),
      max(),
    );
    if (next === current && !event.ctrlKey) return;
    event.preventDefault();
    if (next !== current) set(next);
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; zoom: number } | null = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || pointers.has(event.pointerId)) return;
    // 1 本目はアバターの上だけ。2 本目以降はどこでもよい
    if (
      pointers.size === 0 &&
      !(event.target instanceof Node && el.contains(event.target))
    )
      return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      pinch = { distance: spread(), zoom: get() };
      onPinch?.(true);
    }
  };
  const onMove = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    if (!pinch || pinch.distance === 0) return;
    set(clampZoom((pinch.zoom * spread()) / pinch.distance, max()));
  };
  const onUp = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pinch && pointers.size < 2) {
      pinch = null;
      onPinch?.(false);
    }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  return () => {
    el.removeEventListener("wheel", onWheel);
    window.removeEventListener("pointerdown", onDown, { capture: true });
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (pinch) onPinch?.(false);
  };
}
