// media モジュールの公開口（サイトで使う写真）。他モジュールはここからだけ import する。
export { default as Photo } from "./components/Photo.astro";
export { PHOTOS, type PhotoAsset, type PhotoKey } from "./lib/photos";
