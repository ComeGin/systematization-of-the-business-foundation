// atelier モジュール（ヒーロー第 2 版「デザイナーのアトリエ」）の公開口。ページ・レイアウトはここの部品だけを使う。
// 設計は docs/superpowers/specs/2026-10-28-hero-atelier-design.md。ブラウザで動くコードは ./client から import する。
export { default as AtelierHero } from "./components/AtelierHero.astro";
export { default as AtelierStill } from "./components/AtelierStill.astro";
export * from "./client";
