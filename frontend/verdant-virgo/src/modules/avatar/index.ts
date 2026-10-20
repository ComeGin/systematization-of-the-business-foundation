// avatar モジュールの公開口。ページ・レイアウトはここの AvatarDock だけを使う（client:* は AvatarDock が持つ）。
// ブラウザで動くコードは ./client から import する。
export { default as AvatarDock } from "./components/AvatarDock.astro";
export * from "./client";
