// motion モジュールの公開口（計画書 P-10 と「インタラクションデザイン」）。ページ・レイアウトはここのラッパーだけを使う。
// 水和の指示（client:*）はラッパーの .astro が持つ。置く側は client:* を書かない（Mobile で読まない条件などを置き場所ごとにばらつかせない）。
// React Bits の原本は vendor/react-bits/ にあり、直接 import しない。island の中から使う部品は ./client から。
export { default as MotionSymbol } from "./components/MotionSymbol.astro";
export { default as MotionNav } from "./components/MotionNav.astro";
export { default as MorphGallery } from "./components/MorphGallery.astro";
export { default as MotionBlobs } from "./components/MotionBlobs.astro";
export * from "./client";
export type {
  MotionNavLink,
  MotionNavProps,
  MorphGalleryItem,
  MorphGalleryProps,
  MotionSymbolProps,
  MotionBlobsProps,
} from "./lib/types";
