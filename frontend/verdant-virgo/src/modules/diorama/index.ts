// diorama モジュール（ヒーローの「基盤の模型」）の公開口。ページ・レイアウトはここの部品だけを使う。
// 設計は docs/superpowers/specs/2026-10-28-hero-diorama-design.md。ブラウザで動くコードは ./client から import する。
export { default as DioramaHero } from "./components/DioramaHero.astro";
export { default as DioramaIntro } from "./components/DioramaIntro.astro";
export { default as DioramaStill } from "./components/DioramaStill.astro";
export * from "./client";
