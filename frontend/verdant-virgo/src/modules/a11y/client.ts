// a11y モジュールのブラウザ用の公開口。ブラウザで動くコード（<script>・island）はここから import する
// （.astro を含まない）。横断のアクセシビリティの処理は各モジュールにばらまかず、ここを通す（計画書 P-4・P-6）。
// 文言の既定値は持たない（03-handoff.md H-16）。文言は site-content/a11y.ts から渡す。
export { default as NewTabNotice } from "./components/NewTabNotice";
export { default as VisuallyHidden } from "./components/VisuallyHidden";
export { default as MotionPause } from "./components/MotionPause";
export {
  prefersReducedMotion,
  onReducedMotionChange,
} from "./lib/reduced-motion";
export { useReducedMotion } from "./lib/use-reduced-motion";
export { contrastRatio, relativeLuminance } from "./lib/contrast";
export { newTabNoticeHtml } from "./lib/new-tab";
export type {
  MotionPauseProps,
  NewTabNoticeProps,
  VisuallyHiddenProps,
} from "./lib/types";
