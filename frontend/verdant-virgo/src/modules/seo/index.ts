// seo モジュールの公開口。他モジュールはここからだけ import する（2026-11-04 に新設）。
// 構造化データ（JSON-LD）の組み立てと出力、記事の OGP 画像。ビルド時（.astro の frontmatter）だけで使う。
// 画面ごとの title・description・noindex の値は site-content/seo.ts（文言の正本）に置き、ここには置かない。
// sitemap の lastmod のインテグレーション（comeginSitemapLastmod）は astro.config.mjs が ./integration から直接 import する。
export {
  aboutPageJsonLd,
  blogPostingJsonLd,
  homeJsonLd,
  representativePerson,
  schemaIds,
  serializeJsonLd,
  type BlogPostingInput,
} from "./lib/jsonld";
export { articleOgImage, OG_IMAGE_SIZE } from "./lib/og-image";
export { default as JsonLd } from "./components/JsonLd.astro";
