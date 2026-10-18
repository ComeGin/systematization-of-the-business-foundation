// motion モジュールのブラウザ用の公開口（.astro を含まない）。island（React）の中から使う部品はここから import する。
export { default as SendStatusMark } from "./components/SendStatusMark";
export { default as SendStatusAnnouncer } from "./components/SendStatusAnnouncer";
export {
  DURATION,
  EASE,
  SPIN_PERIOD,
  cubicBezier,
  easing,
  cssColor,
  type DurationName,
  type EaseName,
} from "./lib/tokens";
export {
  runWhenVisible,
  type RunWhenVisibleOptions,
} from "./lib/run-when-visible";
export type {
  SendStatusState,
  SendStatusMarkProps,
  SendStatusAnnouncerProps,
} from "./lib/types";
