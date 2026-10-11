import type { RichText } from './rich-text';

/** 表のセル。lines は「画面では改行して分けて表示する」セル（10-B の契約の書類など） */
export type LegalTableCell = RichText | { readonly lines: readonly RichText[] };

export interface LegalTable {
  /** 見出し行。左から順に */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly LegalTableCell[])[];
  /**
   * Mobile の組み。3 列以上の表は行ごとの Card にする（§4.10 10-A の D/M）。
   * 2 列の表は Mobile でも表のまま（項目列を固定し、内容を折り返す）。
   * Desktop の列幅は固定せず、折り返しで同じ結果を出す（03-handoff §0.3）。
   */
  readonly mobile: 'table' | 'cards';
}

export interface LegalListItem {
  readonly content: RichText;
  /** 字下げした子の項目（10-A の 2 節の (1)〜(7) の中身） */
  readonly children?: readonly LegalListItem[];
}

export type LegalBlock =
  | { readonly kind: 'paragraph'; readonly content: RichText }
  | { readonly kind: 'list'; readonly items: readonly LegalListItem[] }
  | { readonly kind: 'table'; readonly table: LegalTable }
  /** 節の中の小見出し（h3）。目次には出さない */
  | { readonly kind: 'subheading'; readonly text: string };

/** 番号付きの節（h2）。h2 と目次には「1. 事業者の名称と所在地」の形で番号を出す（§4.10） */
export interface LegalSection {
  /** ページ内アンカー（目次のリンク先） */
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly blocks: readonly LegalBlock[];
}

export interface BreadcrumbItem {
  readonly label: string;
  /** 現在のページはリンクにしない（§1.5）ので href を持たない */
  readonly href?: string;
}

interface LegalPageBase {
  readonly path: string;
  readonly breadcrumb: readonly BreadcrumbItem[];
  /** h1 */
  readonly title: string;
  /** h1 の下の小さい文字。仕様書の 1 行ずつ */
  readonly dates: readonly string[];
}

/** 10-A。目次あり（Desktop は本文の左に固定、Mobile は本文の前に Accordion） */
export interface SectionedLegalPage extends LegalPageBase {
  readonly kind: 'sectioned';
  /** 目次の見出し */
  readonly tocLabel: string;
  /** 1 節より前の文。画面に「前文」という見出しは出さない */
  readonly preamble: readonly LegalBlock[];
  readonly sections: readonly LegalSection[];
}

/** 10-B。本文が表 1 つなので目次を置かない */
export interface TableLegalPage extends LegalPageBase {
  readonly kind: 'table';
  readonly table: LegalTable;
  /** 表の下の文 */
  readonly after: readonly LegalBlock[];
}

export type LegalPage = SectionedLegalPage | TableLegalPage;

export const sectionHeading = (section: LegalSection): string => `${section.number}. ${section.title}`;
