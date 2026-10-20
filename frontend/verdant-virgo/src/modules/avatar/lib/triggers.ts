// アバターの合図（AvatarTrigger）の検知（設計書 §7.2・§9。2026-10-20 の裁定 R20）。ブラウザ専用。React・three に依存しない。
//   arrive … 監視を始めたとき（＝アバターが出たとき）。受け手が手を振る（セッションで 1 回。R17）
//   idle   … ポインター・スクロール・キーの操作が IDLE_AFTER_MS の間無いとき。受け手が待機の呼吸に入る
//   wake   … idle を受理した後に、初めて操作があったとき。受け手が直立に戻る（訪問者が戻ってきたのに気づく）
// 押した（tap）は AvatarStage が自分で出す。ページの印（料金の節）・CTA・送信の成功では合図を出さない（R20）。
// 出してよいか（一時停止・たたんだ・画面外）は受け取る側（AvatarStage）が決め、受理したかを返す。
// 受理されなかった合図は消費しない（R18）: idle は操作が無い限り RETRY_MS ごとに出し直し、wake は次の操作で出し直す。
import { IDLE_AFTER_MS } from "./emotes";
import type { AvatarTrigger } from "./types";

/** 受理されなかった idle を出し直す間（ms） */
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

/** 合図の監視を始める。戻り値で監視をやめる */
export function watchTriggers(emit: (t: AvatarTrigger) => boolean): () => void {
  const cleanups: (() => void)[] = [];

  emit("arrive");

  // 操作のたびにタイマーを作り直さず、最後の操作の時刻だけを覚えて、満ちたら出す。
  // idle を受理したら（呼吸に入ったら）次の操作まで見ない。操作が来たら wake を出し、そこからまた IDLE_AFTER_MS を数える
  let lastActivity = performance.now();
  let resting = false;
  let timer = 0;
  const schedule = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(check, ms);
  };
  const check = () => {
    timer = 0;
    const quiet = performance.now() - lastActivity;
    if (quiet < IDLE_AFTER_MS) schedule(IDLE_AFTER_MS - quiet);
    else if (emit("idle")) resting = true;
    else schedule(RETRY_MS);
  };
  const touch = () => {
    lastActivity = performance.now();
    if (!resting || !emit("wake")) return;
    resting = false;
    schedule(IDLE_AFTER_MS);
  };
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, touch, { passive: true, capture: true });
    cleanups.push(() =>
      window.removeEventListener(type, touch, { capture: true }),
    );
  }
  schedule(IDLE_AFTER_MS);
  cleanups.push(() => window.clearTimeout(timer));

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
