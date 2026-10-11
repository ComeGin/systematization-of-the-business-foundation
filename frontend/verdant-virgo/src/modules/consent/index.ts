// consent モジュールの公開口。他モジュールはここからだけ import する。
// ブラウザで動くコードは ./client（.astro を含まない）から import する。
export * from './client';
export { default as ConsentBanner } from './components/ConsentBanner.astro';
