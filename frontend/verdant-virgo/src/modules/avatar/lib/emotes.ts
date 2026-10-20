// エモートの定義と、押した（tap）ときの選び方（設計書 §7.2。2026-10-20 の裁定 R20）。React・three に依存しない（単体テストの対象）。
//   出た        … 手を振る（greeting。セッションで 1 回。R17。AvatarStage が出す）
//   しばらく操作が無い … 待機の呼吸（BreathingIdle のループ。それまでは直立。lib/stage.ts の rest）
//   押した      … 上の 2 つ以外の 5 本（うなずく・指さす・考える・喜ぶ・全身を見せる）から 1 本
// ページの印・CTA・送信の成功では動かさない（動きは訪問者が押した結果だけにする）。A（vivid）と B（calm）で同じ。
// 押したときの選び方: 5 本を混ぜた袋から順に出し、袋が空になったら混ぜ直す（同じ身ぶりが続かず、5 回で全部を見られる）。
// 再生中に押されたら、いまの身ぶりを切り替える（押したのに何も起きない、を避ける）。ただし連打で身ぶりがちらつかないよう、前に受けてから intervalMs は受けない。
import type { EmoteId } from "./types";

/** 押したときに出す身ぶり（手を振る＝出たとき、待機＝しばらく操作が無いときは含めない） */
export const TAP_EMOTES = [
  "nod",
  "point",
  "think",
  "peace",
  "show-full-body",
] as const satisfies readonly EmoteId[];

/** ポインター・スクロール・キーの操作がこの間無ければ、待機の呼吸に入る */
export const IDLE_AFTER_MS = 15_000;

/** 押したのを受けてから、次に押したのを受けるまでの間（連打で身ぶりを細切れにしない） */
const TAP_INTERVAL_MS = 1_000;

export interface EmoteSchedulerOptions {
  intervalMs?: number;
  /** 0 以上 1 未満の乱数（テストで差し替える） */
  random?: () => number;
}

export interface EmoteScheduler {
  /** 押したのを受けて、いま再生するエモートを返す。受けないときは null。now はミリ秒（performance.now() など） */
  next(now: number): EmoteId | null;
}

export function createEmoteScheduler({
  intervalMs = TAP_INTERVAL_MS,
  random = Math.random,
}: EmoteSchedulerOptions = {}): EmoteScheduler {
  let bag: EmoteId[] = [];
  let last: EmoteId | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;

  const refill = () => {
    bag = [...TAP_EMOTES];
    // Fisher–Yates で混ぜる
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [bag[i], bag[j]] = [bag[j]!, bag[i]!];
    }
    // 袋の境目でも同じ身ぶりを続けない（前の袋の最後と、次の袋の最初を違うものにする）
    if (bag.length > 1 && bag[0] === last)
      [bag[0], bag[1]] = [bag[1]!, bag[0]!];
  };

  return {
    next(now) {
      if (now - lastAt < intervalMs) return null;
      if (bag.length === 0) refill();
      const emote = bag.shift()!;
      last = emote;
      lastAt = now;
      return emote;
    },
  };
}
