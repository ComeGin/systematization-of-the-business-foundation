// エモートの定義と、合図（AvatarTrigger）との対応（設計書 §7.2。U-8）。React・three に依存しない（単体テストの対象）。
//   A（vivid）… 着いたら手を振る／料金・プランの節で うなずく／主 CTA に触れたら指さす／しばらく何もしなければ考える・全身を見せる／送信できたら喜ぶ
//   B（calm） … 着いたら手を振る／送信できたら喜ぶ（ほかは何もしない）
// 同じエモートを短い間に繰り返さない（cooldownMs）。1 つの再生中は次を受けない（そのエモートのクリップの長さ durationsMs。表に無ければ playMs。R18）。
import type { LiveZone } from "@/modules/motion/client";
import type { AvatarTrigger, EmoteId } from "./types";

/** 区分ごとの「合図 → エモート」。idle は表の think から始めて、スケジューラーが think と show-full-body を交互に返す */
export const EMOTE_TABLE: Record<LiveZone, Partial<Record<AvatarTrigger, EmoteId>>> = {
  vivid: {
    arrive: "greeting",
    "reach-pricing": "nod",
    "cta-intent": "point",
    "form-success": "peace",
    idle: "think",
  },
  calm: {
    arrive: "greeting",
    "form-success": "peace",
  },
};

/** A（vivid）だけ。ポインター・スクロール・キーの操作がこの間無ければ idle の合図を出す */
export const IDLE_AFTER_MS = 15_000;

/** 同じエモートを繰り返さない間（既定） */
const COOLDOWN_MS = 20_000;
/** 1 つの再生中に次を受けない間（durationsMs に長さが無いエモートの既定） */
const PLAY_MS = 3_000;

/** idle で交互に出す 2 つ（最初は think） */
const IDLE_EMOTES = ["think", "show-full-body"] as const satisfies readonly EmoteId[];

export interface EmoteSchedulerOptions {
  cooldownMs?: number;
  playMs?: number;
  /** エモートごとのクリップの長さ（ms。AvatarDock がビルド時に JSON の duration を切り上げて渡す）。その間は次を受けない */
  durationsMs?: Partial<Record<EmoteId, number>>;
}

export interface EmoteScheduler {
  /** 合図を受けて、いま再生するエモートを返す。再生しないときは null。now はミリ秒（performance.now() など） */
  request(trigger: AvatarTrigger, now: number): EmoteId | null;
}

export function createEmoteScheduler(
  zone: LiveZone,
  { cooldownMs = COOLDOWN_MS, playMs = PLAY_MS, durationsMs = {} }: EmoteSchedulerOptions = {},
): EmoteScheduler {
  const table = EMOTE_TABLE[zone];
  const lastPlayed = new Map<EmoteId, number>();
  let busyUntil = Number.NEGATIVE_INFINITY;
  let idleTurn = 0;

  return {
    request(trigger, now) {
      const listed = table[trigger];
      if (!listed) return null;
      const emote = trigger === "idle" ? IDLE_EMOTES[idleTurn % IDLE_EMOTES.length]! : listed;
      if (now < busyUntil) return null;
      const last = lastPlayed.get(emote);
      if (last !== undefined && now - last < cooldownMs) return null;
      lastPlayed.set(emote, now);
      busyUntil = now + (durationsMs[emote] ?? playMs);
      // 順番は再生したときだけ進める（捨てた idle で think を飛ばさない）
      if (trigger === "idle") idleTurn++;
      return emote;
    },
  };
}
