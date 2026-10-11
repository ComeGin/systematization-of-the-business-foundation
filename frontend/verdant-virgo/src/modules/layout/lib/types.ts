/** パンくずの 1 段。現在のページは href を持たない（リンクにしない。01-content-spec.md §1.5） */
export interface BreadcrumbItem {
  label: string;
  href?: string;
}

/** ヘッダー（と Mobile の Sheet）の「無料相談」の強さ。ブログ一覧・記事だけ outline（§1.3 の F2） */
export type HeaderCta = 'primary' | 'outline';

/** パンくずの帯の地。直後が PageIntro（role/surface-subtle）なら subtle、白い面なら surface */
export type BreadcrumbTone = 'subtle' | 'surface';

/** ホーム（パンくずの先頭。Breadcrumb が自動で足す） */
export const HOME_CRUMB: Required<BreadcrumbItem> = { label: 'ホーム', href: '/' };
