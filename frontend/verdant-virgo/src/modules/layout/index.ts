// layout モジュールの公開口。他モジュールはここからだけ import する。
export { default as BaseLayout } from './components/BaseLayout.astro';
export type { Props as BaseLayoutProps } from './components/BaseLayout.astro';
export { default as SiteHeader } from './components/SiteHeader.astro';
export { default as MobileMenuSheet } from './components/MobileMenuSheet.astro';
export { default as SiteFooter } from './components/SiteFooter.astro';
export { default as Breadcrumb } from './components/Breadcrumb.astro';
export { default as AnnouncementBanner } from './components/AnnouncementBanner.astro';
export { default as PageIntro } from './components/PageIntro.astro';
export { HOME_CRUMB, type BreadcrumbItem, type BreadcrumbTone, type HeaderCta } from './lib/types';
