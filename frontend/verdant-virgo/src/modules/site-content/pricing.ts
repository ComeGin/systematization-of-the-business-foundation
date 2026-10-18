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
  /** 金額（税込） */
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
    note: '4回から',
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

/**
 * お支払いの時期（4-6 の表・4-8 の FAQ・特商法 10-B で同じ文にする）。2026-10-14 にユーザー判断でクレジットカード払いを追加
 */
export const PAYMENT_TIMING =
  '銀行振込は、月末締め、翌月末払いです。クレジットカード払いは、お申し込みの日に初回を決済し、その後は 1か月ごとに決済します。';

/** 月額のプランの料金が発生し始める起点（4-8 の FAQ・特商法 10-B）。2026-10-14 にユーザー判断で決まった */
export const BILLING_START = '契約締結日または発注日の、いずれか遅い日';

/** 料金を出すすべての箇所（料金カード群・比較表・サービスカード群の直下など）に置く注記 */
export const TAX_NOTE = '表示価格はすべて税込です。';

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
    'DX の推進を、バイブコーディングで小さく作って確かめながら進めるための伴走です。ComeGin は調査と知見をご提供し、実務はお客さまに進めていただきます。4回からお申し込みいただけます。',
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
  /** 4-5a 見積もりの計算のしかた（2026-10-13 に追加。Desktop・Mobile とも 2 列の表） */
  readonly estimate: SectionCopy & {
    readonly lead: readonly string[];
    readonly columns: readonly [string, string];
    readonly rows: readonly { readonly key: PricingKey; readonly formula: string }[];
    /** 表の直下の計算例。1 行目が条件、2 行目が式 */
    readonly example: readonly [string, string];
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
      /** 表の直下の箇条書き（創業計画書 第3項「体験の約束」1。2026-10-13 に追加） */
      readonly notes: readonly string[];
    };
  };
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
  intro: ['すべてのサービスの金額と期間です。表示価格はすべて税込です。'],
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
    columns: ['プロダクト', '金額（税込）', '期間', '備考'],
  },
  // 4-5a（2026-10-13。創業計画書 別紙1 第8章「料金表と見積の計算式を Web で公開し、業務棚卸しの当日に概算を示す」）
  estimate: {
    heading: '見積もりの計算のしかた',
    lead: ['見積もりは、料金表の金額を次の式に当てはめて出します。', '無料の業務棚卸しの当日に、この式で費用の概算をお伝えします。'],
    columns: ['プロダクト', '計算のしかた'],
    rows: [
      { key: 'environment-setup', formula: `${ENVIRONMENT_SETUP_PRICE}（定額）` },
      { key: 'development-vibe', formula: `${PRICING['development-vibe'].price}（定額）` },
      { key: 'development-full', formula: `${DEVELOPMENT_FULL_PRICE} × 開発の月数 ＋ ${MAINTENANCE_PRICE} × 保守の月数` },
      { key: 'consulting', formula: `${PRICING.consulting.price} × 回数（4回から）` },
      { key: 'partnership', formula: 'レベニューシェアによる回収計画を、個別に決めます。' },
    ],
    // 1-4c のカード 1 の 285万円と同じ例
    example: [
      '例: 受託開発を 3か月、保守を 9か月ご契約の場合',
      `${DEVELOPMENT_FULL_PRICE} × 3か月 ＋ ${MAINTENANCE_PRICE} × 9か月 ＝ 2,850,000円`,
    ],
  },
  // 4-6
  paymentAndContract: {
    heading: 'お支払いと契約について',
    payment: {
      heading: 'お支払いについて',
      rows: [
        ['お支払い方法', 'クレジットカード、銀行振込'],
        ['お支払いの時期', PAYMENT_TIMING],
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
        // 10.2 の C12' は 2026-10-14 にユーザー判断で決まった（環境構築と同じ条件）
        {
          key: 'development-vibe',
          cells: ['業務委託基本契約書 ＋ 発注書', '1年（自動更新）', '契約解除合意書のお申し出による'],
        },
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
      // 業務提携はレベニューシェアの回収計画と結びつくため、違約金なしの対象から外した（§4.4 の 4-6。10.2 の C24）
      notes: [
        '環境構築、受託開発、コンサルの解約に、違約金はいただきません。業務提携は、回収の計画とあわせて個別に決めます。',
        '解約のお申し出は、解約する月の前月末までにお願いします。',
        'ご契約の後に料金を改定しても、締結済みのご契約には適用しません。',
        '解約のときは、ソースコード、CSV などの標準形式のデータ、手順書、設定情報をお渡しします。',
      ],
    },
  },
  // 4-7
  // 4-8。見出しは仕様書に無く、Figma（45:7931）の「よくある質問」を採った
  faq: {
    heading: 'よくある質問',
    items: [
      { question: '表示価格は税込ですか？', answer: 'はい。表示価格はすべて税込です。' },
      {
        question: 'お支払いの方法と時期を教えてください',
        answer: `クレジットカードまたは銀行振込でお願いしています。${PAYMENT_TIMING}`,
      },
      {
        question: '月額のプランの料金は、いつから発生しますか？',
        answer: `料金が発生し始める起点は、${BILLING_START}です。${PAYMENT_TIMING}`,
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
