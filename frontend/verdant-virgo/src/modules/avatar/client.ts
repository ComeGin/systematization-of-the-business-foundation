// avatar モジュールのブラウザ用の公開口（.astro を含まない）。
// 2026-10-29 から、代表のアバターはトップのアトリエの中にだけ立つ（画面の端のアバター〈AvatarDock〉はやめた。atelier spec §11・A-13）。
// 人形（lib/figure.ts）は three を使うので、ここから出さない（アトリエの scene.ts が立たせるときだけ動的 import する）。
export type {
  VrmaEmote,
  ProceduralEmote,
  EmoteId,
  MotionClipJson,
  MotionClipTrack,
} from "./lib/types";
