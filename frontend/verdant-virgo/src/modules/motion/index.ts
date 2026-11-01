// motion モジュールの公開口（計画書 P-10 と「インタラクションデザイン」）。ページ・レイアウトはここのラッパーだけを使う。
// 水和の指示（client:*）はラッパーの .astro が持つ。置く側は client:* を書かない（Mobile で読まない条件などを置き場所ごとにばらつかせない）。
// React Bits の原本は vendor/react-bits/ にあり、直接 import しない。island の中から使う部品は ./client から。
export { default as MotionNav } from "./components/MotionNav.astro";
export { default as MorphGallery } from "./components/MorphGallery.astro";
export { default as MotionBlobs } from "./components/MotionBlobs.astro";
export { default as MotionPauseFor } from "./components/MotionPauseFor.astro";
export { default as HeroHeading } from "./sections/hero/HeroHeading.astro";
export { default as GlowGrid } from "./sections/feature/GlowGrid.astro";
export { default as Tilt3d } from "./sections/card3d/Tilt3d.astro";
export { default as ToolMarquee } from "./sections/marquee3d/ToolMarquee.astro";
export { default as Pin3d } from "./sections/pin3d/Pin3d.astro";
export { default as StatRow } from "./sections/stats/StatRow.astro";
export { default as GlobeOsaka } from "./sections/globe3d/GlobeOsaka.astro";
export { default as Reveal } from "./sections/reveal/Reveal.astro";
export { default as CountUp } from "./sections/stats/CountUp.astro";
export { default as CtaGlow } from "./sections/cta/CtaGlow.astro";
export { default as ReadingProgress } from "./sections/blog-content/ReadingProgress.astro";
export { default as TocTracker } from "./sections/blog-content/TocTracker.astro";
export * from "./client";
export type {
  MotionNavLink,
  MotionNavProps,
  MorphGalleryItem,
  MorphGalleryProps,
  MotionBlobsProps,
  MotionPauseForProps,
  HeroHeadingProps,
  GlowGridProps,
  Tilt3dProps,
  ToolMarqueeProps,
  Pin3dProps,
  StatRowProps,
  GlobeOsakaProps,
  RevealProps,
  CountUpProps,
  CtaGlowProps,
  TocTrackerProps,
} from "./lib/types";
export type { MotionZone, LiveZone } from "./lib/zone";
