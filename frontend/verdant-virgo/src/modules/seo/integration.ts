// sitemap の記事に <lastmod> を足す Astro インテグレーション（2026-11-04 に新設）。astro.config.mjs で sitemap() の後に登録する。
//
// - Google は lastmod を「一貫して正確なら」再クロールの判断に使う。正確な値を持つのは記事（Strapi の updatedAt）だけなので、記事にだけ付ける。
//   固定ページにビルドの日時を付けると、内容が変わっていないのに毎回「更新」になり、lastmod 全体が信用されなくなる
// - 設定ファイルの中では Strapi を読めない（import.meta.env が無い）。そこで、ビルドの最後（astro:build:done）に、
//   dist/ の記事の HTML の <meta property="article:modified_time"> を読み、sitemap-*.xml の同じ URL の <url> に <lastmod> を書き足す
//   （値の正本は記事のページの meta と同じ Strapi の updatedAt。sitemap と画面の日付が食い違わない）
// - 記事の meta が無い・URL が sitemap に無いときは何もしない（ビルドは止めない。sitemap は lastmod が無くても正しい）
// - dev サーバーでは何もしない（sitemap はビルドでだけ作られる）
// 出典: https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap#additional-notes-about-xml-sitemaps
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

const MODIFIED_META =
  /<meta\s+property="article:modified_time"\s+content="([^"]+)"/;

/** dist/ の HTML を再帰的に列挙する */
async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name === "index.html") out.push(full);
  }
  return out;
}

export function comeginSitemapLastmod(): AstroIntegration {
  let site: URL | undefined;
  return {
    name: "comegin-sitemap-lastmod",
    hooks: {
      "astro:config:done": ({ config }) => {
        site = config.site ? new URL(config.site) : undefined;
      },
      "astro:build:done": async ({ dir, logger }) => {
        if (!site) return;
        const distDir = fileURLToPath(dir);
        const blogDir = path.join(distDir, "blog");

        // 記事の URL（canonical と同じ末尾スラッシュ付き）→ 更新日時
        const lastmod = new Map<string, string>();
        let files: string[] = [];
        try {
          files = await htmlFiles(blogDir);
        } catch {
          return; // 記事の無いビルド
        }
        for (const file of files) {
          const match = MODIFIED_META.exec(await readFile(file, "utf8"));
          if (!match) continue; // 一覧・カテゴリ・ページ送り
          const rel = path
            .relative(distDir, path.dirname(file))
            .split(path.sep)
            .join("/");
          lastmod.set(
            new URL(`/${rel}/`, site).href,
            new Date(match[1]).toISOString(),
          );
        }
        if (lastmod.size === 0) return;

        let added = 0;
        const sitemaps = (await readdir(distDir)).filter((name) =>
          /^sitemap-\d+\.xml$/.test(name),
        );
        for (const name of sitemaps) {
          const file = path.join(distDir, name);
          const xml = await readFile(file, "utf8");
          const next = xml.replace(
            /<url><loc>([^<]+)<\/loc>(?!<lastmod>)/g,
            (whole, loc: string) => {
              const value = lastmod.get(loc);
              if (!value) return whole;
              added += 1;
              return `<url><loc>${loc}</loc><lastmod>${value}</lastmod>`;
            },
          );
          if (next !== xml) await writeFile(file, next);
        }
        logger.info(`sitemap の記事 ${added} 件に lastmod を付けた`);
      },
    },
  };
}
