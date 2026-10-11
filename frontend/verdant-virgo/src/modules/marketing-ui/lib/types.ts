export type CTAButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'link';
export type CTAButtonSize = 'sm' | 'default' | 'lg';
export type CTAButtonIcon = 'download' | 'arrow-right' | 'external-link';

/** 見出しの階層。セクション見出しは h2、カードの見出しは h3（01-content-spec.md §7 の注） */
export type HeadingLevel = 'h2' | 'h3' | 'h4';

/** Section の地の色（役割トークン。03-handoff.md §3） */
export type SectionTone = 'surface' | 'subtle' | 'brand-strong';

/** Section の中身の最大幅（コンテンツ 1152 ／ 記事・本文 720 ／ フォーム 640。03-handoff.md §4） */
export type SectionWidth = 'content' | 'article' | 'form';

/** 価格の 1 行（01-content-spec.md §2 の表の 1 行。ServiceCard の価格の枠） */
export interface PriceRow {
  /** プロダクト名（「本プロジェクトの環境構築」など） */
  product: string;
  /** 金額（「23,000円」「500,000円／月」「要相談」など） */
  price: string;
  /** 期間（「1日」「60〜90日」「—」など） */
  period: string;
}

/** 手順の 1 段（Steps・StepItem） */
export interface StepContent {
  title: string;
  body?: string;
  /** 見出しの直下の期間（サービス詳細 3-6 の 5 段階） */
  period?: string;
  /** 本文の中で途中で改行させない語（文節の折り返しでも語の途中で切れるもの。H-18） */
  keepTogether?: readonly string[];
}
