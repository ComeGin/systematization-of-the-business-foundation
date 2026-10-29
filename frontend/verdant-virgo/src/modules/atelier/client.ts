// atelier モジュールのブラウザ用の公開口（.astro を含まない）。island・素の <script>・単体テストはここから import する。
// three を使う描画（lib/scene.ts）はここから出さない（島が出すと決めたときだけ動的 import する）。
export { PROPS, assertPropsOneToOne } from "./lib/props";
export { SELF_FRAMES, FRAME_SLOTS, wallFrames } from "./lib/frames";
export { STILL_VIEWS, pageKeyForPath } from "./lib/pages";
export { createRail, LANE_SWITCH_MAX_GAP, LEFT_LANE_DX, type Rail } from "./lib/route";
export { createWalker, type Walker } from "./lib/walk";
export {
  PHASE_BOUNDS,
  PHASE_LIGHTS,
  PHASE_STORAGE_KEY,
  phaseAt,
  visitPhase,
  type PhaseLight,
} from "./lib/sky";
export { MOTIONS, pickMotion } from "./lib/motions";
export { VT_MAX_AGE_MS, VT_STORAGE_KEY, afterFlight, readVt, writeVt, type AtelierVt } from "./lib/transition";
export { decideQuality, type Quality } from "./lib/quality";
export { readGlbJson, type GlbJson } from "./lib/glb";
export {
  layoutMarkers,
  type MarkerPoint,
  type MarkerLayoutOptions,
} from "./lib/markers";
export type {
  PageKey,
  PropId,
  PropDef,
  FrameId,
  FrameDef,
  StillView,
  Phase,
  MotionName,
} from "./lib/types";
