// faq-export モジュール: Web サイトの FAQ を faq.json（I-33。faq-bot が読む）の形にする。
// 契約は docs/superpowers/specs/2026-10-11-faq-bot-design.md の 5 節。faq-bot の検証は backend/faq-bot/src/faq/schema.ts。
// site-content は相対パスで読む（backend/faq-bot の照合の評価のテストが、別名〈@/〉の設定なしにこのファイルを読むため）。
import { TOP } from "../site-content/top";
import { PRICING_PAGE } from "../site-content/pricing";
import {
  SERVICE_CARDS,
  SERVICE_DETAILS,
  SERVICE_ORDER,
  type FaqItemCopy,
} from "../site-content/services";

export interface FaqExportItem {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly url: string;
  readonly context: string | null;
}

export interface FaqExport {
  readonly version: 1;
  readonly generated_at: string;
  readonly items: readonly FaqExportItem[];
}

export interface FaqPage {
  readonly key: string;
  readonly path: string;
  /** FAQ の見出しの id（SectionHeading） */
  readonly anchor: string;
  /** ページの名前。同じ質問が複数のページにあるため、ボットの選択肢で見分けるのに使う */
  readonly context: string | null;
  readonly items: readonly FaqItemCopy[];
}

// marker の付け忘れに備えて、本文に残った印でも除く（未完成の回答を訪問者に返さない）
const UNFINISHED = /【要(記入|確認)】/;

export function faqPages(): readonly FaqPage[] {
  return [
    {
      key: "top",
      path: "/",
      anchor: "top-faq",
      context: null,
      items: TOP.faq.items,
    },
    {
      key: "pricing",
      path: "/pricing",
      anchor: "pricing-faq",
      context: "料金",
      items: PRICING_PAGE.faq.items,
    },
    ...SERVICE_ORDER.map((slug) => ({
      key: `services-${slug}`,
      path: `/services/${slug}`,
      anchor: "detail-faq",
      context: SERVICE_CARDS[slug].title,
      items: SERVICE_DETAILS[slug].faq.items,
    })),
  ];
}

/** id は「ページ-元の順番（1 から）」。除いた項目も数えるので、印を外しても他の項目の id は動かない */
export function exportItems(
  page: FaqPage,
  siteUrl: string | URL,
): FaqExportItem[] {
  const url = new URL(`${page.path}#${page.anchor}`, siteUrl).href;
  return page.items.flatMap((item, index) =>
    item.marker ||
    UNFINISHED.test(item.question) ||
    UNFINISHED.test(item.answer)
      ? []
      : [
          {
            id: `${page.key}-${index + 1}`,
            question: item.question,
            answer: item.answer,
            url,
            context: page.context,
          },
        ],
  );
}

export function buildFaqExport(
  siteUrl: string | URL,
  generatedAt: Date = new Date(),
): FaqExport {
  return {
    version: 1,
    generated_at: generatedAt.toISOString(),
    items: faqPages().flatMap((page) => exportItems(page, siteUrl)),
  };
}
