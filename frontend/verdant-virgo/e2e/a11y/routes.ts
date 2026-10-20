// a11y の自動検査（pnpm a11y）で使う、ルートの一覧と出力先の定義。
// ルートは dist/**/*.html から作る（lighthouserc.cjs の firstArticlePath と同じ発想）。
// 公開済みの全記事・カテゴリ・ページ送り・noindex の画面も、ビルドされていれば自動で入る（計画書の P-1）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DIST_DIR = path.join(ROOT, "dist");

// preview のポート（計画書の P-8。4321 は dev、4322 は Lighthouse CI）
export const PORT = 4323;
export const BASE_URL = `http://localhost:${PORT}`;

// 結果の置き場所。.a11y/ 直下の *.json だけを builtin の a11y ジョブが作業ツリーへ写す
export const A11Y_DIR = path.join(ROOT, ".a11y");
export const PAGES_DIR = path.join(A11Y_DIR, "pages");
export const RUN_FILE = path.join(PAGES_DIR, "_run.json");
export const SUMMARY_FILE = path.join(A11Y_DIR, "summary.json");

// JIS X 8341-3:2016（= WCAG 2.0 の A/AA）に加え、WCAG 2.1/2.2 の AA で増えた基準も見る（計画書の U-4）
export const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

// 存在しないパス。preview が 404.html を 404 で返すことを異常系で確かめる
export const NOT_FOUND_ROUTE = "/__a11y-not-found__/";

// Playwright の projects の名前（playwright.config.ts と合わせる）
export const PROJECTS = ["desktop", "mobile"] as const;

/** dist の HTML からルート（末尾 /）を名前順で返す。404.html は除く（NOT_FOUND_ROUTE で検査する） */
export function distRoutes(): string[] {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error(
      "dist がありません。先に SITE_URL=https://comegin.com pnpm build を実行してください。",
    );
  }
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // シンボリックリンクはたどらない。_astro・.prerender は資産とビルドの中間物
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "_astro" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && entry.name === "index.html") {
        const rel = path
          .relative(DIST_DIR, path.dirname(full))
          .split(path.sep)
          .join("/");
        routes.push(rel ? `/${rel}/` : "/");
      }
    }
  };
  walk(DIST_DIR);
  if (routes.length === 0) {
    throw new Error(
      "dist に index.html が 1 件もありません。先に SITE_URL=https://comegin.com pnpm build を実行してください。",
    );
  }
  return routes.sort();
}

/**
 * テンプレートごとに 1 本だけ選んだルート（名前順の先頭）。キーボードの一周など、1 ページの検査が重いものに使う。
 * 記事・カテゴリ・ページ送り・サービスの詳細は同じテンプレートなので 1 本にし、それ以外はすべて残す。
 */
export function templateRoutes(): string[] {
  const groups: [string, RegExp][] = [
    ["blog-category-page", /^\/blog\/category\/[^/]+\/page\/[^/]+\/$/],
    ["blog-category", /^\/blog\/category\/[^/]+\/$/],
    ["blog-page", /^\/blog\/page\/[^/]+\/$/],
    ["blog-article", /^\/blog\/(?!category\/|page\/)[^/]+\/$/],
    ["service", /^\/services\/[^/]+\/$/],
  ];
  const seen = new Set<string>();
  return distRoutes().filter((route) => {
    const group = groups.find(([, re]) => re.test(route))?.[0];
    if (!group) return true;
    if (seen.has(group)) return false;
    seen.add(group);
    return true;
  });
}

/** dist/sitemap-*.xml の <loc> のパス名を返す（sitemap-index.xml は除く） */
export function sitemapPaths(): string[] {
  const files = fs
    .readdirSync(DIST_DIR)
    .filter((name) => /^sitemap-\d+\.xml$/.test(name));
  return files.flatMap((name) => {
    const xml = fs.readFileSync(path.join(DIST_DIR, name), "utf8");
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (m) => new URL(m[1]).pathname,
    );
  });
}

/** ルートを結果のファイル名にする（/ → top、/blog/page/2/ → blog__page__2） */
export function slugOf(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  return trimmed ? trimmed.replace(/\//g, "__") : "top";
}
