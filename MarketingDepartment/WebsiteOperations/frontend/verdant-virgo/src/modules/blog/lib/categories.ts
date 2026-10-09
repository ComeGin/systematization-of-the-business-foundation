// ブログのカテゴリ（01-content-spec.md §4.7 の 7-4 のタブ。検索意図の 3 分類）。
// Strapi のカテゴリとは slug で対応させる（開発の Strapi に同じ slug で作ってある。本番も同じ slug で作る）。
import type { SearchIntent } from './types';

export const BLOG_CATEGORIES = [
  { slug: 'know-the-issues', label: '課題を知る', intent: 'latent' },
  { slug: 'compare-methods', label: '手法を比べる', intent: 'semi' },
  { slug: 'consider-adoption', label: '導入を検討する', intent: 'explicit' },
] as const satisfies readonly { slug: string; label: string; intent: SearchIntent }[];

export type BlogCategorySlug = (typeof BLOG_CATEGORIES)[number]['slug'];

/** タブの先頭（§4.7 の 7-4） */
export const ALL_CATEGORIES_LABEL = 'すべて';

export function findBlogCategory(slug: string | undefined) {
  return BLOG_CATEGORIES.find((category) => category.slug === slug);
}
