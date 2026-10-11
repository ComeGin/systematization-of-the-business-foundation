// 記事の取得と整形（DD-05 の 1.2・1.3）。
// - 公開済み（publishedAt あり）だけを取る。0 件ならビルドを失敗させる（空のサイトを公開しない）。
// - 1 回のビルドで 1 度だけ取得し、一覧・カテゴリ・記事のページで使い回す。
// - 公開サイトに出すメディアが画像でなければビルドを失敗させる（1.5.3）。
import { strapiGet, StrapiBuildError } from './strapi';
import { BLOG_CATEGORIES, findBlogCategory } from './categories';
import type { Article, ArticleBlock, SearchIntent, StrapiMedia } from './types';

const PAGE_SIZE = 100;

const QUERY = [
  'status=published',
  'sort[0]=publishedAt:desc',
  `pagination[pageSize]=${PAGE_SIZE}`,
  'populate[cover]=true',
  'populate[category]=true',
  'populate[author][populate][avatar]=true',
  'populate[blocks][on][shared.rich-text]=true',
  'populate[blocks][on][shared.quote]=true',
  'populate[blocks][on][shared.media][populate][file]=true',
  'populate[blocks][on][shared.slider][populate][files]=true',
]
  .map((part) => {
    const [key, value] = part.split('=');
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  })
  .join('&');

interface ListResponse {
  data: unknown[];
  meta: { pagination: { page: number; pageCount: number } };
}

function assertImage(media: StrapiMedia | null | undefined, where: string): StrapiMedia | null {
  if (!media) return null;
  if (!media.mime?.startsWith('image/')) {
    throw new StrapiBuildError(`${where} のメディアが画像ではありません（${media.mime}）。公開サイトでは画像だけを使えます。`);
  }
  return media;
}

function normalizeBlock(block: ArticleBlock, slug: string): ArticleBlock {
  switch (block.__component) {
    case 'shared.rich-text':
    case 'shared.quote':
      return block;
    case 'shared.media':
      return { ...block, file: assertImage(block.file, `記事「${slug}」の media`) };
    case 'shared.slider':
      return { ...block, files: (block.files ?? []).map((file) => assertImage(file, `記事「${slug}」の slider`)!) };
    default:
      throw new StrapiBuildError(`記事「${slug}」に未対応のブロック（${(block as { __component: string }).__component}）があります。`);
  }
}

function normalizeArticle(raw: unknown): Article | null {
  const item = raw as Partial<Article> & { blocks?: ArticleBlock[] };
  if (!item.publishedAt) return null;
  if (!item.slug || !item.title) {
    throw new StrapiBuildError(`タイトルか slug が空の公開記事があります（documentId: ${item.documentId ?? '不明'}）。`);
  }
  return {
    documentId: item.documentId ?? item.slug,
    title: item.title,
    description: item.description ?? '',
    slug: item.slug,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt ?? item.publishedAt,
    cover: assertImage(item.cover, `記事「${item.slug}」の cover`),
    category: item.category ? { name: item.category.name, slug: item.category.slug } : null,
    author: item.author
      ? { name: item.author.name, avatar: assertImage(item.author.avatar, `記事「${item.slug}」の著者の avatar`) }
      : null,
    blocks: (item.blocks ?? []).map((block) => normalizeBlock(block, item.slug!)),
  };
}

async function fetchAllArticles(): Promise<Article[]> {
  const articles: Article[] = [];
  for (let page = 1; ; page++) {
    const response = await strapiGet<ListResponse>(`articles?${QUERY}&${encodeURIComponent('pagination[page]')}=${page}`);
    if (!Array.isArray(response.data) || !response.meta?.pagination) {
      throw new StrapiBuildError('記事の一覧の応答の形が想定と違います。');
    }
    for (const raw of response.data) {
      const article = normalizeArticle(raw);
      if (article) articles.push(article);
    }
    if (page >= response.meta.pagination.pageCount) break;
  }
  if (articles.length === 0) {
    throw new StrapiBuildError('公開済みの記事が 0 件です。記事が無いままサイトを公開しないため、ビルドを止めます（DD-05 の 1.2）。');
  }
  for (const article of articles) {
    if (article.category && !findBlogCategory(article.category.slug)) {
      console.warn(
        `[blog] 記事「${article.slug}」のカテゴリ「${article.category.slug}」はタブ（${BLOG_CATEGORIES.map((c) => c.slug).join('・')}）にありません。検索意図は「課題を知る」として扱います。`,
      );
    }
  }
  return articles;
}

let cache: Promise<Article[]> | null = null;

/** 公開済みの記事（新しい順）。ビルドでは 1 回のビルドで 1 度だけ取得する */
export function getAllArticles(): Promise<Article[]> {
  // dev サーバーでは表示のたびに取り直す（Strapi で直した記事を、再起動せずに確かめられるように）
  if (import.meta.env.DEV) return fetchAllArticles();
  cache ??= fetchAllArticles();
  return cache;
}

export async function getArticlesByCategory(slug: string): Promise<Article[]> {
  return (await getAllArticles()).filter((article) => article.category?.slug === slug);
}

/** 記事の検索意図。カテゴリが無い・タブに無いときは「課題を知る」（潜在）に倒す（商談の CTA を出さない側） */
export function getArticleIntent(article: Article): SearchIntent {
  return findBlogCategory(article.category?.slug)?.intent ?? 'latent';
}

/** 関連する記事（8-9）。同じカテゴリの新しい順、足りなければほかの記事で埋める */
export async function getRelatedArticles(article: Article, count = 3): Promise<Article[]> {
  const others = (await getAllArticles()).filter((other) => other.slug !== article.slug);
  const sameCategory = others.filter((other) => other.category?.slug === article.category?.slug);
  const rest = others.filter((other) => other.category?.slug !== article.category?.slug);
  return [...sameCategory, ...rest].slice(0, count);
}

/** 一覧のページ送り（§4.7 の 7-4。Desktop 3 列 × 3 行 ＝ 9 件） */
export const ARTICLES_PER_PAGE = 9;

export function paginate<T>(items: readonly T[], perPage = ARTICLES_PER_PAGE): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  return pages.length > 0 ? pages : [[]];
}

/** 「YYYY年M月D日」（JST。§4.7・§4.8 の日付の書き方） */
export function formatJstDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}年${parts.month}月${parts.day}日`;
}
