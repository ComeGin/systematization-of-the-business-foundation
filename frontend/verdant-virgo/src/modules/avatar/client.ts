// avatar モジュールのブラウザ用の公開口（.astro を含まない）。
// three を使う描画（lib/stage.ts）はここから出さない（AvatarStage が出すと決めたときだけ動的 import する）。
export { EMOTE_TABLE, IDLE_AFTER_MS, createEmoteScheduler, type EmoteScheduler, type EmoteSchedulerOptions } from "./lib/emotes";
export { FORM_SUCCESS_EVENT, watchTriggers } from "./lib/triggers";
export { SCROLL_SETTLE_MS, watchScrollAway, type ScrollAwayOptions } from "./lib/scroll-away";
export { readCollapsed, writeCollapsed, readGreeted, writeGreeted } from "./lib/prefs";
export type {
  AvatarTrigger,
  VrmaEmote,
  ProceduralEmote,
  EmoteId,
  AvatarLabels,
  MotionClipJson,
  MotionClipTrack,
} from "./lib/types";
