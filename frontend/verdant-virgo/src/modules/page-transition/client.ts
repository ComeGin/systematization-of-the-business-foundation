// page-transition モジュールのブラウザ用の公開口（.astro を含まない）。
export { isStillPath, shouldSkipTransition } from "./lib/rules";
export { VT, vtStyle, type VtName } from "./lib/names";
export { installPageSwap, morphTargetsFor, normalizePath } from "./lib/morph";
