// page-transition モジュールの公開口。ページ・レイアウトはここの部品だけを使う。
// ブラウザで動くコードは ./client から import する。
export { default as PageTransition } from "./components/PageTransition.astro";
export { default as PageTransitionHead } from "./components/PageTransitionHead.astro";
export * from "./client";
