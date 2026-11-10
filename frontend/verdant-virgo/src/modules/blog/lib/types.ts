// Strapi の記事の型（backend/strapi-system の api::article.article・shared.* のスキーマのうち、公開サイトで使うもの）。

export interface StrapiMedia {
  url: string;
  alternativeText: string | null;
  width: number | null;
  height: number | null;
  mime: string;
  /** Strapi のファイル名（拡張子つき）。配布ファイルのリンクの名前に使う */
  name?: string | null;
  /** Strapi の size（KB） */
  size?: number | null;
}

/**
 * 公開サイトから配るファイル（zip・PDF。DD-05 の 1.5.3）。ビルドで Strapi から取得し、dist/files/<hash>/<name> に置く。
 * sourceUrl はビルドの取得にだけ使い、ページには出さない（1.5.4）。
 */
export interface DistributionFile {
  /** サイト内のパス（/files/<hash>/<name>） */
  href: string;
  hash: string;
  /** href の最後の部分。表示とダウンロードのファイル名 */
  name: string;
  mime: 'application/zip' | 'application/pdf';
  /** Strapi の size（KB）。無ければ null */
  sizeKb: number | null;
  sourceUrl: string;
}

export interface BlogCategory {
  name: string;
  slug: string;
}

export interface BlogAuthor {
  name: string;
  avatar: StrapiMedia | null;
}

export type ArticleBlock =
  | { __component: 'shared.rich-text'; id: number; body: string | null }
  | { __component: 'shared.quote'; id: number; title: string | null; body: string | null }
  | { __component: 'shared.media'; id: number; file: StrapiMedia | null; download?: DistributionFile }
  | { __component: 'shared.slider'; id: number; files: StrapiMedia[] | null };

export interface Article {
  documentId: string;
  title: string;
  /** 要約（80 字まで）。一覧の BlogCard と meta description に使う */
  description: string;
  slug: string;
  publishedAt: string;
  updatedAt: string;
  cover: StrapiMedia | null;
  category: BlogCategory | null;
  author: BlogAuthor | null;
  blocks: ArticleBlock[];
}

/** 記事の検索意図（01-content-spec.md §4.8。BA-04 の CTA の出し分け） */
export type SearchIntent = 'latent' | 'semi' | 'explicit';
