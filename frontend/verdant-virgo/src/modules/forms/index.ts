// forms モジュールの公開口。他モジュールはここからだけ import する。
// ページに置くのは ContactFormBlock（/contact の 6-4）。
// フォーム ID（MAUTIC_FORM_ID_CONSULT）と同意の版はこれがビルド時に読む（ページから渡さない。P-8）。
// 無料 DL ブロックのメールのフォーム（SourceDownloadBlock）は 2026-10-20 に消した（どのページも source-dl の SourceDlBlock の CTA にした）。
export { default as ContactFormBlock } from './components/ContactFormBlock.astro';
export { default as FormField, RequirementBadge, type Requirement } from './components/FormField';
export { default as ConsentCheckbox } from './components/ConsentCheckbox';
export { default as CheckboxField } from './components/CheckboxField';
