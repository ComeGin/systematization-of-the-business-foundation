// diorama モジュールのブラウザ用の公開口（.astro を含まない）。island・素の <script>・単体テストはここから import する。
// three を使う描画（lib/scene.ts）はここから出さない（島が出すと決めたときだけ動的 import する）。
export { PARTS } from "./lib/parts";
export { FLOWS, assertFlowsLogical } from "./lib/flows";
export { PAGE_VIEWS } from "./lib/pages";
export {
  createParticleSystem,
  STAGE_COLOR,
  type Particle,
  type Arrival,
  type ParticleSystem,
  type ParticleOptions,
} from "./lib/particles";
export { decideQuality, type Quality } from "./lib/quality";
export { readGlbJson, type GlbJson } from "./lib/glb";
export { layoutMarkers, type MarkerPoint, type MarkerLayoutOptions } from "./lib/markers";
export { dioramaZoomOrigin, pageKeyForPath } from "./lib/transition";
export type {
  PartId,
  PartDef,
  Stage,
  FlowId,
  FlowStep,
  PageKey,
  PageView,
} from "./lib/types";
