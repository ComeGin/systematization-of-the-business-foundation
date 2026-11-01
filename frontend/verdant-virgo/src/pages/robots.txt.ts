// robots.txt（2026-11-02 に追加。それまで本番では 404 だった）。ビルドで dist/robots.txt になる。
// - すべてのクローラーにすべてのページを許す。noindex の画面（/contact/thanks・404 など。01-content-spec.md §1.1）も Disallow にしない
//   （Disallow にするとクローラーがページを読めず、noindex の指定に気づけない。noindex は meta で伝える）
// - Sitemap は @astrojs/sitemap が出すインデックス（Search Console に送ったものと同じ URL）。ホストは astro.config.mjs の site（SITE_URL）から作る。
//   SITE_URL を www 付きなどに変えれば、ここも一緒に変わる
// 出典: https://developers.google.com/search/docs/crawling-indexing/robots/create-robots-txt
//      https://docs.astro.build/en/guides/integrations-guide/sitemap/（robots.txt にサイトマップを書く例）
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error("site が未設定（astro.config.mjs の site）");
  const sitemap = new URL("sitemap-index.xml", site).href;
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${sitemap}`,
    "",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
