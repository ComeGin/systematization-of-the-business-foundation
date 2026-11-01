// 代表のアバターの身ぶり（spec §6.4）。押すと MOTIONS から 1 つをランダムに選ぶ。直前と同じものは続けて選ばない。
// クリップは src/modules/avatar/assets/motions/（idle は待機なので含めない）。
import type { MotionName } from "./types";

export const MOTIONS: readonly MotionName[] = [
  "greeting",
  "nod",
  "peace",
  "point",
  "show-full-body",
  "think",
];

export function pickMotion(
  last: MotionName | null,
  random: () => number,
): MotionName {
  const pool = last ? MOTIONS.filter((m) => m !== last) : MOTIONS;
  const r = Math.min(Math.max(random(), 0), 0.999999);
  return pool[Math.floor(r * pool.length)];
}
