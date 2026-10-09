// blog モジュールの公開口。他モジュールはここからだけ import する。
// ここにあるものはビルド時（.astro の frontmatter・getStaticPaths）だけで使う。ブラウザのコードから import しない。
// ビルドの失敗条件のインテグレーション（comeginStrapiGuard）は astro.config.mjs が ./integration から直接 import する。
export {
  getAllArticles,
  getArticlesByCategory,
  getArticleIntent,
  getRelatedArticles,
  paginate,
  ARTICLES_PER_PAGE,
  formatJstDate,
} from './lib/articles';
export { BLOG_CATEGORIES, ALL_CATEGORIES_LABEL, findBlogCategory, type BlogCategorySlug } from './lib/categories';
export { prepareArticleBody, type PreparedBody, type TocItem } from './lib/body';
export type { Article, BlogCategory, BlogAuthor, StrapiMedia, SearchIntent } from './lib/types';
export { default as ArticleBlocks } from './components/ArticleBlocks.astro';
export { default as StrapiImage } from './components/StrapiImage.astro';
