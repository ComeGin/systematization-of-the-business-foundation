// ヘッダー・Mobile のメニュー・フッターのリンクと文言。
// 正本は docs/BasicDesign/DesignSpec/website/01-content-spec.md の §1.3・§1.4。
// 文言は一字一句写す（和欧間は半角スペース。H-17 は「文字としてのスペースを入れ、CSS の text-autospace は使わない」に決めた。計画書 P-2）。

import type { CtaId } from './cta';

export interface NavLink {
  label: string;
  href: string;
}

/**
 * 公開リポジトリの URL（§1.4 の列 3・§6.3.1）。2026-10-14 にユーザーが決めた（03-handoff.md §0.3 の F3-R の URL）。
 * null にすると「ソースコード（GitHub）」「ソースコードを見る（GitHub）」のリンクを出さない
 * （F3-R「公開前の画面に『公開しています』と出さない」）。
 * フッターと無料 DL ブロック（forms）の両方がこの値を使う。
 */
const REPOSITORY = 'https://github.com/kamegin4-aws/systematization-of-the-business-foundation';
export const SOURCE_REPO_URL: string | null = REPOSITORY;

/**
 * 「ソースコードを無料 DL」を押したときにダウンロードさせる zip（GitHub のタグのアーカイブ）。2026-10-14 にユーザーが決めた。
 * 押すと別のタブでこの zip を開き（GitHub が添付ファイルとして返すのでダウンロードが始まる）、元のタブは無料相談（/contact）へ移る。
 * 動きは source-dl モジュール。新しいタグを切ったら、ここを差し替える。
 */
export const SOURCE_ZIP_URL = `${REPOSITORY}/archive/refs/tags/test-v0.1.zip`;

/** ヘッダーのナビ（§1.3。Mobile の Sheet のリンク 4 つも同じ） */
export const headerNav: readonly NavLink[] = [
  { label: 'サービス', href: '/services' },
  { label: '料金', href: '/pricing' },
  { label: '会社概要', href: '/about' },
  { label: 'ブログ', href: '/blog' },
];

/** ヘッダー・Sheet の「無料相談」ボタン（§1.3。ラベルは画面によらず同じ） */
export const headerCta = {
  label: '無料相談',
  desktopCtaId: 'consult_global_header',
  sheetCtaId: 'consult_global_sheet',
} as const satisfies { label: string; desktopCtaId: CtaId; sheetCtaId: CtaId };

/** Sheet の副 CTA（§1.3 の 5。単独のリンクなので「を」を入れる） */
export const sheetSourceDl = {
  label: 'ソースコードを無料 DL',
  ctaId: 'dl_global_sheet',
} as const satisfies { label: string; ctaId: CtaId };

/**
 * フッターの列 1 の説明文（§1.4）。Figma の改行位置（読点・句点の後）で 3 行に分けて持つ。
 * つなげると仕様書の文と一字一句同じになる。
 */
export const footerDescriptionLines: readonly string[] = [
  '社内に IT 人材がいなくても、',
  '1人分の予算で実現する業務改善。',
  'システム開発と IT コンサルティング。',
];

export type FooterItem =
  | { kind: 'link'; label: string; href: string; ctaId?: CtaId; external?: boolean }
  /** 「Cookie 設定」: ページ遷移しない button。consent モジュールが [data-consent-open] を拾ってバナーを再表示する */
  | { kind: 'consent-settings'; label: string };

export interface FooterColumn {
  heading: string;
  items: readonly FooterItem[];
}

/** フッターの列 2〜4（§1.4。列 3 は体言止めでそろえるので「ソースコード無料 DL」に「を」を入れない） */
export const footerColumns: readonly FooterColumn[] = [
  {
    heading: 'サービス',
    items: [
      { kind: 'link', label: '環境構築', href: '/services/environment-setup' },
      { kind: 'link', label: '受託開発', href: '/services/development' },
      { kind: 'link', label: 'コンサル', href: '/services/consulting' },
      { kind: 'link', label: '業務提携', href: '/services/partnership' },
      { kind: 'link', label: '料金', href: '/pricing' },
    ],
  },
  {
    heading: 'ComeGin について',
    items: [
      { kind: 'link', label: '会社概要', href: '/about' },
      { kind: 'link', label: 'ブログ', href: '/blog' },
      // §6.3 の 4: consult_global_footer（遷移先に ?cta=・?from= を付ける。SiteFooter が組み立てる）
      { kind: 'link', label: '無料相談', href: '/contact', ctaId: 'consult_global_footer' },
      { kind: 'link', label: 'ソースコード無料 DL', href: '/#source-dl', ctaId: 'dl_global_footer' },
      // CTA ではない（§6.3.1）。外部・新しいタブ。SOURCE_REPO_URL が null の間は出さない
      ...(SOURCE_REPO_URL
        ? [{ kind: 'link', label: 'ソースコード（GitHub）', href: SOURCE_REPO_URL, external: true } as const]
        : []),
    ],
  },
  {
    heading: '規約・ポリシー',
    items: [
      { kind: 'link', label: 'プライバシーポリシー', href: '/legal/privacy' },
      { kind: 'link', label: '特定商取引法に基づく表記', href: '/legal/tokushoho' },
      { kind: 'consent-settings', label: 'Cookie 設定' },
    ],
  },
];

/** フッター下段（§1.4） */
export const copyright = '© 2026 ComeGin';
