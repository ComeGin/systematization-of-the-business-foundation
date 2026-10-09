// 料金の正本（01-content-spec.md §2）と料金ページ（§4.4）の文言。
// 画面に料金（金額・期間・備考）を出す箇所は、すべてこのファイルから読む。ほかのファイルに金額を書かない。
// 文言は仕様書から一字一句写す。和欧間の半角スペースは仕様書のまま（CSS の text-autospace は使わない。計画書 P-2）。
// 数字と単位は密着（「23,000円」「1日」。§2 の例外 2）。

import type { CtaId } from './cta';
import type { FaqSection, SectionCopy } from './services';

/** §2 の 5 行。キーは /contact?service= に渡す値と同じ */
export type PricingKey =
  | 'environment-setup'
  | 'development-vibe'
  | 'development-full'
  | 'consulting'
  | 'partnership';

export interface PricingRow {
  readonly key: PricingKey;
  /** プロダクト名（「本プロジェクトの環境構築」は原文のまま。言い換えない） */
  readonly product: string;
  /** 金額（税別） */
  readonly price: string;
  readonly period: string;
  /** 備考。無い行は null（表では空欄） */
  readonly note: string | null;
}

/** 環境構築の金額。文中（無料 DL ブロックの本文など）でも使う */
export const ENVIRONMENT_SETUP_PRICE = '23,000円';
/** 環境構築の期間。文中でも使う */
export const ENVIRONMENT_SETUP_PERIOD = '1日';
/** 要件定義〜運用保守の月額。文中（3-7 の Q2、1-4c の注記）でも使う */
export const DEVELOPMENT_FULL_PRICE = '500,000円／月';
/** 保守のみの月額。§2 の備考の中の値で、文中（2-4 カード 2、3-6 の 5、1-4c の注記）でも使う */
export const MAINTENANCE_PRICE = '150,000円／月';

// §2 料金（正本）
export const PRICING: Readonly<Record<PricingKey, PricingRow>> = {
  'environment-setup': {
    key: 'environment-setup',
    product: '本プロジェクトの環境構築',
    price: ENVIRONMENT_SETUP_PRICE,
    period: ENVIRONMENT_SETUP_PERIOD,
    note: 'ソースコードは無料で配布',
  },
  'development-vibe': {
    key: 'development-vibe',
    product: '受託開発：バイブコーディングのみ',
    price: '50,000円',
    period: '7日',
    note: null,
  },
  'development-full': {
    key: 'development-full',
    product: '受託開発：要件定義〜運用保守',
    price: DEVELOPMENT_FULL_PRICE,
    period: '60〜90日',
    note: `保守のみ ${MAINTENANCE_PRICE}`,
  },
  consulting: {
    key: 'consulting',
    product: 'コンサル',
    price: '31,250円／回',
    period: '4時間／回',
    note: '初回相談は無料・4回から',
  },
  partnership: {
    key: 'partnership',
    product: '業務提携',
    price: '要相談',
    period: '—',
    note: 'レベニューシェアによる回収計画',
  },
};

/** §2 の表の並び順 */
export const PRICING_ORDER: readonly PricingKey[] = [
  'environment-setup',
  'development-vibe',
  'development-full',
  'consulting',
  'partnership',
];

export const PRICING_ROWS: readonly PricingRow[] = PRICING_ORDER.map((key) => PRICING[key]);

/** 料金を出すすべての箇所（料金カード群・比較表・サービスカード群の直下など）に置く注記 */
export const TAX_NOTE = '表示価格はすべて税別です。';

/**
 * プロダクトごとの 1 行説明（§4.4 の 4-4 の表）。
 * カード 1 は §2 の補足、カード 2・3 は §4.3 の 3-4 のプランの説明、
 * カード 4・5 は §4.2 の 2-4 のサービスカードの本文と同じ文（仕様書が「同じ文にする」と定めているので 1 か所に置く）。
 */
export const PRICING_DESCRIPTIONS: Readonly<Record<PricingKey, string>> = {
  'environment-setup': 'ComeGin の事業経営基盤一式を、お客さまのクラウドまたは端末に構築します。',
  'development-vibe':
    'AI コーディングエージェントと対話しながら短いサイクルで実装し、動くものをお渡しします。',
  'development-full':
    '定期常駐で、何を作るかの整理から、設計、開発、テスト、リリース、リリース後の運用保守までを担当します。',
  consulting:
    'KPI の設計、検索意図に合わせた記事と CTA の設計、月次の改善会議の運営を支援します。初回のご相談は無料で、4回からお申し込みいただけます。',
  partnership:
    '福祉・介護・教育事業を行う中小企業、社会福祉法人、非営利団体の皆さまと提携します。回収の計画は個別にご相談のうえ決めます。',
};

// ---------------------------------------------------------------------------
// 画面 4 料金（/pricing）。§4.4
// ---------------------------------------------------------------------------

export interface PricingCardCopy {
  readonly key: PricingKey;
  readonly badge: string | null;
  /** ボタン（主）。遷移先は /contact?service=<key> */
  readonly cta: { readonly label: string; readonly ctaId: CtaId };
  /** 追加リンク（副）→ #source-dl */
  readonly sourceDlLink: { readonly label: string; readonly ctaId: CtaId } | null;
}

export interface PricingPageCopy {
  readonly h1: string;
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  /** 4-3 導入ヒーロー */
  readonly intro: readonly string[];
  /** 4-4 料金カード。Desktop は 3 列 ＋ 2 列（上段 1〜3、下段 4〜5）、Mobile は 1 列 */
  readonly cards: {
    /** 期間のラベル。金額のラベルは付けない */
    readonly periodLabel: string;
    readonly items: readonly PricingCardCopy[];
  };
  /** 4-5 料金一覧表。Mobile では出さない */
  readonly table: SectionCopy & {
    readonly columns: readonly [string, string, string, string];
  };
  /** 4-6 お支払いと契約について */
  readonly paymentAndContract: SectionCopy & {
    readonly payment: {
      readonly heading: string;
      /** 見出し行は出さない（Figma 46:7634 は「項目｜内容」の行を持たない）。左列が項目、右列が内容 */
      readonly rows: readonly (readonly [string, string])[];
    };
    readonly contract: {
      readonly heading: string;
      /** Mobile では行ごとに Card にし、2〜4 列目の見出しをラベルとして縦積みにする */
      readonly columns: readonly [string, string, string, string];
      readonly rows: readonly { readonly key: PricingKey; readonly cells: readonly [string, string, string] }[];
    };
  };
  /** 4-7 無料 DL ブロックの文言は 2-7（services.ts の SOURCE_DL_NEUTRAL）と同じ */
  readonly sourceDlCtaId: CtaId;
  /** 4-8 よくある質問 */
  readonly faq: FaqSection;
  /** 4-9 CTA バナー */
  readonly banner: {
    readonly title: string;
    readonly body: string;
    readonly cta: { readonly label: string; readonly ctaId: CtaId };
  };
}

const PRICING_CARD_CTA_LABEL = 'このサービスを相談する';

export const PRICING_PAGE: PricingPageCopy = {
  h1: '料金：環境構築・受託開発・コンサル・業務提携',
  // 4-2 パンくず
  breadcrumb: [{ label: 'ホーム', href: '/' }, { label: '料金' }],
  // 4-3
  intro: ['すべてのサービスの金額と期間です。表示価格はすべて税別です。'],
  // 4-4
  cards: {
    periodLabel: '期間',
    items: [
      {
        key: 'environment-setup',
        badge: null,
        cta: { label: PRICING_CARD_CTA_LABEL, ctaId: 'consult_pricing_card' },
        sourceDlLink: { label: 'ソースコードを無料 DL', ctaId: 'dl_pricing_card' },
      },
      {
        key: 'development-vibe',
        badge: null,
        cta: { label: PRICING_CARD_CTA_LABEL, ctaId: 'consult_pricing_card' },
        sourceDlLink: null,
      },
      {
        key: 'development-full',
        badge: null,
        cta: { label: PRICING_CARD_CTA_LABEL, ctaId: 'consult_pricing_card' },
        sourceDlLink: null,
      },
      {
        key: 'consulting',
        badge: null,
        cta: { label: PRICING_CARD_CTA_LABEL, ctaId: 'consult_pricing_card' },
        sourceDlLink: null,
      },
      {
        key: 'partnership',
        badge: '福祉・介護・教育',
        cta: { label: PRICING_CARD_CTA_LABEL, ctaId: 'consult_pricing_card' },
        sourceDlLink: null,
      },
    ],
  },
  // 4-5
  table: {
    heading: '料金一覧',
    columns: ['プロダクト', '金額（税別）', '期間', '備考'],
  },
  // 4-6
  paymentAndContract: {
    heading: 'お支払いと契約について',
    payment: {
      heading: 'お支払いについて',
      rows: [
        ['お支払い方法', 'クレジットカード、銀行振込'],
        ['お支払いの時期', '月末締め、翌月末払い'],
        ['料金以外に必要な費用', 'クラウド（サードパーティのライセンスを含む）の利用料は、お客さまのご負担です。'],
      ],
    },
    contract: {
      heading: 'ご契約について',
      columns: ['サービス', '契約の書類', '契約期間', '解約'],
      // 1 列目のサービス名は PRICING[key].product を出す
      rows: [
        {
          key: 'environment-setup',
          cells: ['業務委託基本契約書 ＋ 発注書', '1年（自動更新）', '契約解除合意書のお申し出による'],
        },
        // 契約条件が未決（10.2 の C12'）。行ごと消さず【要記入】のまま置く。
        // Figma（116:13248）にはこの行に仕様書に無い値が入っているが、正本は仕様書なので採らない
        { key: 'development-vibe', cells: ['【要記入】', '【要記入】', '【要記入】'] },
        {
          key: 'development-full',
          cells: ['システム開発委託契約書 ＋ 発注書', '成果物の納品（検収終了）まで', '契約解除合意書による'],
        },
        {
          key: 'consulting',
          cells: ['コンサルティング契約書 ＋ 発注書', '1か月（自動更新）', '契約解除合意書のお申し出による'],
        },
        {
          key: 'partnership',
          cells: ['業務提携契約書 ＋ 発注書', '1年（自動更新）', '契約解除合意書のお申し出による'],
        },
      ],
    },
  },
  // 4-7
  sourceDlCtaId: 'dl_pricing_section',
  // 4-8。見出しは仕様書に無く、Figma（45:7931）の「よくある質問」を採った
  faq: {
    heading: 'よくある質問',
    items: [
      { question: '表示価格は税込ですか？', answer: 'いいえ。表示価格はすべて税別です。' },
      {
        question: 'お支払いの方法と時期を教えてください',
        answer: 'クレジットカードまたは銀行振込でお願いしています。お支払いは月末締め、翌月末払いです。',
      },
      {
        question: '月額のプランの料金は、いつから発生しますか？',
        answer: 'お支払いは月末締め、翌月末払いです。料金が発生し始める起点は【要記入】。',
        marker: '要記入',
      },
      {
        question: 'クラウドの利用料は料金に含まれますか？',
        answer: '含まれません。クラウド（サードパーティのライセンスを含む）の利用料は、お客さまのご負担です。',
      },
      {
        question: '業務提携の条件を教えてください',
        answer:
          '福祉・介護・教育事業を行う中小企業、社会福祉法人、非営利団体の皆さまです。開発の費用はレベニューシェアで回収する計画を、ご相談のうえ個別に決めます。',
      },
      {
        question: 'ソースコードの無料公開と環境構築サービスの違いは何ですか？',
        answer:
          'ソースコードは無料で公開し、構築の手順書もお渡ししているため、ご自身で構築することもできます。環境構築サービスでは、その構築作業を ComeGin が 1日で行います。',
      },
    ],
  },
  // 4-9
  banner: {
    title: '見積もりの前に、まずはご相談ください',
    body: 'どのプランが合うかを一緒に整理します。相談は無料です。',
    cta: { label: '無料で相談する', ctaId: 'consult_pricing_banner' },
  },
};
