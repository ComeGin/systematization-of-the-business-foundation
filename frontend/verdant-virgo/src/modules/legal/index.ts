// legal モジュールの公開口。他モジュールはここからだけ import する。
export * from './rich-text';
export * from './types';
export { privacyPolicy } from './privacy';
export { tokushoho } from './tokushoho';

export { default as RichTextView } from './components/RichTextView.astro';
export { default as LegalBlocks } from './components/LegalBlocks.astro';
export { default as LegalList } from './components/LegalList.astro';
export { default as LegalTable } from './components/LegalTable.astro';
export { default as LegalToc } from './components/LegalToc.astro';
export { default as LegalPageHeader } from './components/LegalPageHeader.astro';
