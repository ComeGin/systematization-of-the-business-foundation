// 画面 7 ブログ一覧（/blog）と 8 ブログ記事（/blog/<slug>）の、サイト側で持つ文言。正本は 01-content-spec.md §4.7・§4.8。
// 記事そのもの（タイトル・本文・日付・カテゴリ）は blog モジュールが Strapi から取る。BlogCard の「（サンプル）」のダミーは写さない。
// 著者カード（8-7）は about.ts の author（5-5a と一字一句そろえるため）。
// 72.2%／53.8% と 50.8% を置くのは 7-3 だけ（D-6）。記事の本文で繰り返さない。

// カテゴリ名（タブの「すべて」と 3 分類）は blog モジュールの BLOG_CATEGORIES・ALL_CATEGORIES_LABEL を正にする（ここに写さない）
import type { SearchIntent } from "@/modules/blog";

/** 検索意図の 3 分類（潜在／準顕在／顕在・指名）。記事の主 CTA を切り替える（§4.8）。blog モジュールの SearchIntent と同じ */
export type BlogIntent = SearchIntent;

export const blogIndex = {
  path: "/blog",

  // 7-2 パンくず
  breadcrumb: [{ label: "ホーム", href: "/" }, { label: "ブログ" }],

  // 7-3 導入ヒーロー（HERO）。3 段落・6 文。出典は Caption・role/text-muted で、その数字の段落の直下に置く。
  // 段落 1 と出典 1 は 1 つのまとまりとして組む（03-handoff §0.3）
  hero: {
    h1: "ブログ",
    paragraphs: [
      {
        sentences: [
          "現場で起きている困りごとと、その直し方を書いています。",
          "情報セキュリティなど IT の困りごとを相談する先が『特にない』中小企業は、全国で 50.8% です。",
        ],
        source:
          "出典: IPA（情報処理推進機構）「2024年度 中小企業における情報セキュリティ対策に関する実態調査」（2025年）",
      },
      {
        sentences: [
          "この問題がもっとも鋭く現れるのが、介護の現場です。",
          "介護ソフトは、72.2% の事業所で日常的に使われています。",
          "しかし、業務負担の軽減に効果があったとする事業所は 53.8% にとどまります。",
        ],
        source:
          "出典: 公益財団法人介護労働安定センター「令和7年度 介護労働実態調査」",
      },
      {
        sentences: [
          "どこで詰まり、どう直すのかを、課題の整理、手法の比較、導入の進め方の 3つの段階に分けてお届けします。",
        ],
      },
    ],
  },

  // 7-4 カテゴリと記事一覧（CONTENT）。タブは blog モジュールの BLOG_CATEGORIES、Mobile は横スクロール
  // Mobile は「前へ」「次へ」と現在のページだけ
  pagination: { previous: "前へ", next: "次へ" },
  // BlogCard の画像が無いときの枠（16:9）
  imagePlaceholder: "画像（準備中）",

  // 7-5 無料 DL ブロック（CONV、主。強調版。id="source-dl"）。§6.3 の #26 dl_blog_section。
  // SourceDownloadBlock（forms モジュール）の title・body に渡す。ボタン・GitHub のリンクの語・フォームの文言（§5.2）は forms 側
  sourceDownload: {
    heading: "記事で紹介している仕組みは、ソースコードを無料で公開しています",
    body: "読むだけで終わらせたくない方へ。構築の手順書は、メールアドレスだけで受け取れます。",
  },
} as const;

// 7-4 の BlogCard のダミー（9 枚とも同じ中身。Badge だけ 3 枚ずつカテゴリを変えて見た目を示す）。
// ブログ一覧と記事は Strapi の記事を出すので使わない。サービス詳細の 3-8 関連記事（「7-4 と同じ中身」のダミー）が使う。
// 日付は実在の日付を入れない
export const blogCardSample = {
  image: "画像（準備中）",
  title: "記事タイトル（サンプル）",
  excerpt: "記事の要約が入ります。CMS の要約欄の文章を 2行まで表示します。",
  date: "YYYY年M月D日",
} as const;

export const blogArticle = {
  // 8-2 パンくずの親（現在のページは記事タイトル。Mobile は 1 行で省略）
  breadcrumbParents: [
    { label: "ホーム", href: "/" },
    { label: "ブログ", href: "/blog" },
  ],

  // 8-3 記事ヘッダーのメタ情報。「公開日 YYYY年M月D日」「更新日 …」「著者 亀谷 銀大」の形で値の前に置く
  meta: { published: "公開日", updated: "更新日", author: "著者" },
  // アイキャッチが無いときの枠（16:9、本文幅いっぱい）
  imagePlaceholder: "画像（準備中）",

  // 8-4 目次。Desktop は右に追従、Mobile は本文の前の Accordion（閉じた状態）
  tocLabel: "目次",

  // 8-6 記事中 CTA（CONV、主）。最初の h2 の直前。CTABanner の小型・インライン版
  inlineCta: {
    // 潜在・準顕在。§6.3 の #27 dl_article_inline → 同じページの #source-dl。GitHub のリンクは置かない
    sourceDownload: {
      heading: "この記事で紹介する仕組みの、構築の手順書を無料でお渡しします",
      button: "構築の手順書を受け取る",
    },
    // 顕在。§6.3 の #29 consult_article_inline → /contact
    consult: {
      heading: "導入の進め方を、具体的にご相談いただけます",
      button: "無料で相談する",
    },
  },

  // 8-8 記事末 CTA（CONV、主）。§6.3 の #28・#31 dl_article_end（cta_role を検索意図で切り替える）
  endCta: {
    // 潜在・準顕在は強調版、顕在は控えめ版。文言は 7-5 と同じ
    sourceDownload: blogIndex.sourceDownload,
    // 顕在だけ、無料 DL ブロックの上に置く。§6.3 の #30 consult_article_end。本文の指定は無い
    consultBanner: {
      heading: "導入をご検討中なら、無料でご相談ください",
      button: "無料で相談する",
    },
  },

  // 8-9 関連記事（CONTENT）。BlogCard ×3
  related: { heading: "関連する記事" },
} as const;
