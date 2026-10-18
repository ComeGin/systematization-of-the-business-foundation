import { useSyncExternalStore } from "react";
import { onReducedMotionChange, prefersReducedMotion } from "./reduced-motion";

const subscribe = (onChange: () => void) => onReducedMotionChange(onChange);

/**
 * React の island 用。動きを減らす設定なら true。設定を途中で変えたときも追従する。
 * サーバー（と水和の最初の描画）では true を返す。静止した形の HTML を先に出し、
 * 水和の後で設定を見てから動かす（計画書の動きの規則 5「段階的に強化する」）。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => true);
}
