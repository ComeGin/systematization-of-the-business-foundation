// 画面 12 サイトマップ（/sitemap）の文言とリンクの一覧。正本は 01-content-spec.md §4.12（2026-10-18 に G-1 で承認）。
// リンクの語はフッター（§1.4）・ナビ（§1.3）・各画面の h1 にそろえる（同じ行き先に違う名前を付けない。3.2.4）。
// そのため、フッターと同じリンクは nav.ts の footerColumns から作り、ここに写さない。
// ビルド時だけ使う（blog モジュールを読むため。ブラウザのコードから import しない）。
import { BLOG_CATEGORIES } from "@/modules/blog";
import { footerColumns, type FooterColumn, type NavLink } from "./nav";

export interface SitemapGroup {
  heading: string;
  links: readonly NavLink[];
}

const linksOf = (heading: string): NavLink[] => {
  const column: FooterColumn | undefined = footerColumns.find(
    (c) => c.heading === heading,
  );
  if (!column)
    throw new Error(
      `site-content/sitemap: フッターに列「${heading}」がありません。`,
    );
  return column.items.flatMap((item) =>
    item.kind === "link" && !item.external
      ? [{ label: item.label, href: item.href }]
      : [],
  );
};

// 規約・ポリシーの列から、このページ自身を除く（Cookie 設定はページではないので linksOf が除く）
const SELF = "/sitemap";

export const sitemapPage = {
  breadcrumb: [{ label: "ホーム", href: "/" }, { label: "サイトマップ" }],
  h1: "サイトマップ",
  lead: "このサイトのページの一覧です。",
  groups: [
    // フッターの列 2 の先頭に「サービス一覧」を足したもの
    {
      heading: "サービス",
      links: [
        { label: "サービス一覧", href: "/services" },
        ...linksOf("サービス"),
      ],
    },
    // 「トップページ」は 404 のボタン「トップページへ戻る」と語をそろえた
    {
      heading: "ComeGin について",
      links: [
        { label: "トップページ", href: "/" },
        { label: "会社概要", href: "/about" },
        { label: "無料相談", href: "/contact" },
      ],
    },
    // 記事は 1 本ずつ並べない（一覧から辿れる）
    {
      heading: "ブログ",
      links: [
        { label: "ブログ一覧", href: "/blog" },
        ...BLOG_CATEGORIES.map((category) => ({
          label: category.label,
          href: `/blog/category/${category.slug}`,
        })),
      ],
    },
    {
      heading: "規約・ポリシー",
      links: linksOf("規約・ポリシー").filter((link) => link.href !== SELF),
    },
  ],
} as const satisfies {
  breadcrumb: readonly { label: string; href?: string }[];
  h1: string;
  lead: string;
  groups: readonly SitemapGroup[];
};
