// brand モジュールの公開口。他モジュールはここからだけ import する。
export { default as Logo } from './components/Logo.astro';
export { LOGO_RATIO, type LogoColor, type LogoLockup } from './lib/logo';
