// avatar モジュールの公開口。2026-10-29 から、ページ・レイアウトには部品を出さない（画面の端のアバターはやめた。atelier spec §11・A-13）。
// アトリエが読む人形の資産の URL だけを出す。ブラウザで動くコードは ./client から import する。
export { AVATAR_FIGURE_ASSETS } from "./lib/figure-assets";
export * from "./client";
