// forms モジュールの公開口。他モジュールはここからだけ import する。
// ページに置くのは ContactFormBlock（/contact の 6-4）と SourceDownloadBlock（無料 DL ブロック）。
// フォーム ID（MAUTIC_FORM_ID_*）と同意の版はこの 2 つがビルド時に読む（ページから渡さない。P-8）。
export { default as ContactFormBlock } from './components/ContactFormBlock.astro';
export { default as SourceDownloadBlock } from './components/SourceDownloadBlock.astro';
export { default as FormField, RequirementBadge, type Requirement } from './components/FormField';
export { default as ConsentCheckbox } from './components/ConsentCheckbox';
export { default as CheckboxField } from './components/CheckboxField';
