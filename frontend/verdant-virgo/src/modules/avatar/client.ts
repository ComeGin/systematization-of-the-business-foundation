// avatar モジュールのブラウザ用の公開口（.astro を含まない）。
// three を使う描画（lib/stage.ts）はここから出さない（AvatarStage が出すと決めたときだけ動的 import する）。
export { TAP_EMOTES, IDLE_AFTER_MS, createEmoteScheduler, type EmoteScheduler, type EmoteSchedulerOptions } from "./lib/emotes";
export { watchTriggers } from "./lib/triggers";
export { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, clampZoom, watchZoom, type ZoomOptions } from "./lib/zoom";
export { SCROLL_SETTLE_MS, watchScrollAway, type ScrollAwayOptions } from "./lib/scroll-away";
export { YIELD_SETTLE_MS, watchYield } from "./lib/yield";
export { readCollapsed, writeCollapsed, readGreeted, writeGreeted, readZoom, writeZoom } from "./lib/prefs";
export type {
  AvatarTrigger,
  VrmaEmote,
  ProceduralEmote,
  EmoteId,
  AvatarLabels,
  MotionClipJson,
  MotionClipTrack,
} from "./lib/types";
