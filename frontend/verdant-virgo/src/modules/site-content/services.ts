// サービス 4 件の文言。一覧（01-content-spec.md §4.2）と詳細（§4.3・§4.3+）。
// 文言は仕様書から一字一句写す。和欧間の半角スペースは仕様書のまま（計画書 P-2）。
// 金額は pricing.ts から読む（このファイルに金額を書かない）。
// 【要記入】・『要確認』・「（準備中）」の印は消さない。見出しに掛かる「要確認」は見出しの文に混ぜず badge で持つ（§0.1）。

import {
  DEVELOPMENT_FULL_PRICE,
  ENVIRONMENT_SETUP_PERIOD,
  ENVIRONMENT_SETUP_PRICE,
  MAINTENANCE_PRICE,
  PRICING,
  PRICING_DESCRIPTIONS,
  type PricingKey,
} from './pricing';
import type { SearchIntent } from '@/modules/blog';
import { contactHref, type CtaId, type ServiceInterest } from './cta';

// ---------------------------------------------------------------------------
// 文言ファイルの共通の型（top.ts・pricing.ts も使う）
// ---------------------------------------------------------------------------


/** CTA の行き先。/contact へのリンクの ?cta=・?from= はページ側で contactHref() が付ける */
export type CtaTarget =
  | { readonly type: 'contact'; readonly service?: ServiceInterest }
  | { readonly type: 'anchor'; readonly hash: '#source-dl' };

export interface CtaCopy {
  readonly label: string;
  readonly ctaId: CtaId;
  readonly target: CtaTarget;
}

/** CTA ではないページ内・ページ間の移動リンク（計測しない。§6.3） */
export interface LinkCopy {
  readonly label: string;
  readonly href: string;
}

export interface BreadcrumbItem {
  readonly label: string;
  /** 現在のページはリンクにしない */
  readonly href?: string;
}

export interface SectionCopy {
  readonly heading: string;
  /** 見出しの右に置く Badge（Outline、小）。見出しの文には混ぜない（§0.1） */
  readonly headingBadge?: '要確認' | '要記入' | '準備中';
}

export interface StepCopy {
  readonly title: string;
  /** 3-6 だけ。小さい文字（role/text-muted） */
  readonly period?: string;
  readonly body: string;
}

export interface StepsSection extends SectionCopy {
  /** Desktop の段組み。'3+2' ＝ 上段 1〜3・下段 4〜5、'2x2' ＝ 2 列 ×2 段。Mobile はどれも縦 1 列 */
  readonly desktopLayout: '3+2' | '2x2';
  readonly items: readonly StepCopy[];
}

export interface FaqItemCopy {
  readonly question: string;
  readonly answer: string;
  /** 回答に【要記入】【要確認】を含む項目だけ、質問の行の右端に出すバッジ（FAQItem の Show marker） */
  readonly marker?: '要記入' | '要確認';
}

export interface FaqSection extends SectionCopy {
  readonly items: readonly FaqItemCopy[];
}

export interface CtaBannerCopy {
  readonly title: string;
  readonly body: string;
  readonly cta: CtaCopy;
}

/** 無料 DL ブロック（SourceDownloadBlock）のうち、ページで変わる見出しと本文 */
export interface SourceDlCopy {
  readonly title: string;
  /** 要素ごとに行を分けて組む（1 要素 ＝ 1 段落、または文ごとに改行する行。Figma の組み方に合わせた） */
  readonly body: readonly string[];
}

const CONSULT_LABEL = '無料で相談する';
const SOURCE_DL_LABEL = 'ソースコードを無料 DL';

// ---------------------------------------------------------------------------
// 無料 DL ブロック（共通の部分）
// ---------------------------------------------------------------------------

// 無料 DL ブロックのボタン・注記・フォーム・GitHub のリンクの文言は、部品（forms の SourceDownloadBlock）が持つ。
// ここに置くのはページごとに変わる見出しと本文だけ。

/**
 * 中立版の本文で、語の途中で折り返さない語（Q2 の指摘。Mobile で「立ち上げたい方｜へ。」と切れたため）。文言は変えない
 */
export const SOURCE_DL_NEUTRAL_KEEP_TOGETHER: readonly string[] = ['方へ。'];

/**
 * 2-7 無料 DL ブロック（中立版）。中立版の文言の正本はここ。
 * 料金（4-7）と環境構築の詳細ページ（§4.3.1）もこれを使う。トップ（1-9）は top.ts に別の文言がある。
 */
export const SOURCE_DL_NEUTRAL: SourceDlCopy = {
  title: '環境構築のソースコードを無料で公開しています',
  body: [
    `この基盤をご自身の手で立ち上げたい方へ。構築の手順書を、メールアドレスだけでお渡しします。構築を任せたい場合は、環境構築サービス（${ENVIRONMENT_SETUP_PRICE}・${ENVIRONMENT_SETUP_PERIOD}、税別）もご利用いただけます。`,
  ],
};

// ---------------------------------------------------------------------------
// サービスカード（一覧 2-4・トップ 1-7 で共有）
// ---------------------------------------------------------------------------

/** サービス詳細の URL の 4 件（/services/<slug>） */
export type ServiceSlug = 'environment-setup' | 'development' | 'consulting' | 'partnership';

export const SERVICE_ORDER: readonly ServiceSlug[] = [
  'environment-setup',
  'development',
  'consulting',
  'partnership',
];

export interface ServiceCardCopy {
  readonly slug: ServiceSlug;
  readonly title: string;
  readonly badge: string | null;
  readonly body: string;
  /** 価格の行。金額・期間は PRICING[key] から出す。showNote が true の行だけ備考を出す */
  readonly priceRows: readonly { readonly key: PricingKey; readonly showNote: boolean }[];
  /** ボタン「詳しく見る」（Link、Lucide / arrow-right）→ /services/<slug>。CTA ではない */
  readonly detailLink: LinkCopy;
  /**
   * 追加リンク（副）「ソースコードを無料 DL」（Link、Lucide / download）→ #source-dl。
   * cta_id は置く画面ごとに違う（トップ dl_top_card、一覧 dl_services_card）ので、ページ側で渡す
   */
  readonly sourceDlLinkLabel: string | null;
}

const DETAIL_LINK_LABEL = '詳しく見る';

// 2-4 サービスカード。Desktop 2×2、Mobile 1 列。カード群の直下に TAX_NOTE
export const SERVICE_CARDS: Readonly<Record<ServiceSlug, ServiceCardCopy>> = {
  'environment-setup': {
    slug: 'environment-setup',
    title: '環境構築',
    badge: 'ソースコード無料配布',
    body: 'ComeGin の事業経営基盤一式を、お客さまのクラウドまたはお客さまの端末に構築します。ソースコードは無料で配布しているため、ご自身で構築することもできます。',
    priceRows: [{ key: 'environment-setup', showNote: false }],
    detailLink: { label: DETAIL_LINK_LABEL, href: '/services/environment-setup' },
    sourceDlLinkLabel: SOURCE_DL_LABEL,
  },
  development: {
    slug: 'development',
    title: '受託開発',
    badge: null,
    body: `7日間で動くものを作る『バイブコーディングのみ』と、要件定義から運用保守までを定期常駐で担うプランがあります。保守は ${MAINTENANCE_PRICE}です。`,
    priceRows: [
      { key: 'development-vibe', showNote: false },
      { key: 'development-full', showNote: false },
    ],
    detailLink: { label: DETAIL_LINK_LABEL, href: '/services/development' },
    sourceDlLinkLabel: null,
  },
  consulting: {
    slug: 'consulting',
    title: 'コンサル',
    badge: null,
    // 料金ページのカード 4 と同じ文
    body: PRICING_DESCRIPTIONS.consulting,
    priceRows: [{ key: 'consulting', showNote: false }],
    detailLink: { label: DETAIL_LINK_LABEL, href: '/services/consulting' },
    sourceDlLinkLabel: null,
  },
  partnership: {
    slug: 'partnership',
    title: '業務提携',
    badge: '福祉・介護・教育',
    // 料金ページのカード 5 と同じ文
    body: PRICING_DESCRIPTIONS.partnership,
    priceRows: [{ key: 'partnership', showNote: true }],
    detailLink: { label: DETAIL_LINK_LABEL, href: '/services/partnership' },
    sourceDlLinkLabel: null,
  },
};

// ---------------------------------------------------------------------------
// 画面 2 サービス一覧（/services）。§4.2
// ---------------------------------------------------------------------------

export const SERVICES_INDEX = {
  h1: 'サービス：事業経営基盤の構築から運用まで',
  // 2-2 パンくず
  breadcrumb: [{ label: 'ホーム', href: '/' }, { label: 'サービス' }] satisfies readonly BreadcrumbItem[],
  // 2-3 導入ヒーロー（PageIntro。ボタンなし）
  intro: [
    'ComeGin のサービスは 4つです。ソースコードを使ってご自身で立ち上げる、構築を任せる、自社向けに作り込む、運用を一緒に回す。いまの状況に合わせてお選びください。',
  ],
  // 2-4 サービスカード（中身は SERVICE_CARDS）
  cards: {
    sourceDlCtaId: 'dl_services_card' satisfies CtaId,
  },
  // 2-5 どれを選べばよいか。Desktop は Table、Mobile は行ごとに Card
  chooser: {
    heading: 'どれを選べばよいか',
    columns: ['こんなとき', 'おすすめ'],
    /** Mobile の Card で「おすすめ」の行の前に付ける（上の行にはラベルを付けない） */
    mobileRecommendPrefix: 'おすすめ：',
    rows: [
      { situation: 'まずは自分の手で試してみたい', recommend: 'ソースコードの無料 DL' },
      { situation: '基盤の立ち上げを任せたい', recommend: '環境構築' },
      { situation: '自社の業務に合わせて作り込みたい', recommend: '受託開発' },
      { situation: '立ち上げた基盤の運用を一緒に回してほしい', recommend: 'コンサル' },
      { situation: '福祉・介護・教育の事業者として、提携して取り組みたい', recommend: '業務提携' },
    ],
  },
  // 2-6 ご利用の流れ
  flow: {
    heading: 'ご利用の流れ',
    desktopLayout: '3+2',
    items: [
      { title: '無料相談のお申し込み', body: 'フォームから、いまの状況とご相談内容をお送りください。' },
      {
        title: 'オンライン面談のご予約',
        body: '送信後の画面で、空いている日時をお選びいただけます。日程が決まらない場合も、3営業日以内に担当者からメールでご連絡します。',
      },
      {
        title: '業務の棚卸しとご提案',
        body: 'オンライン面談で日程を決め、現場に伺って 4時間で業務を棚卸しします。結果はレポートにまとめ、合うサービスと進め方をご提案します。',
      },
      { title: 'ご契約', body: '内容にご納得いただけたら、電子署名でご契約を締結します。' },
      { title: '実施と振り返り', body: '実施後に結果を一緒に確かめ、次の改善につなげます。' },
    ],
  } satisfies StepsSection,
  // 2-7 無料 DL ブロック（控えめ版。文言は SOURCE_DL_NEUTRAL）
  sourceDlCtaId: 'dl_services_section' satisfies CtaId,
  // 2-8 CTA バナー
  banner: {
    title: 'どのサービスが合うか、一緒に考えます',
    body: '迷っている段階でもかまいません。相談は無料です。',
    cta: { label: CONSULT_LABEL, ctaId: 'consult_services_banner', target: { type: 'contact' } },
  } satisfies CtaBannerCopy,
} as const;

// ---------------------------------------------------------------------------
// 画面 3 サービス詳細（/services/<slug>）。§4.3・§4.3+
// 枠: パンくず → 導入ヒーロー → プラン → こんな方に → 進め方 →（環境構築だけ 無料 DL ブロック）
//     → よくある質問 → 関連記事 → CTA バナー
// ---------------------------------------------------------------------------

export interface PlanCardCopy {
  /** プロダクト名・金額・期間・備考は PRICING[key] から出す */
  readonly key: PricingKey;
  readonly badge: string | null;
  /** 説明は PRICING_DESCRIPTIONS[key] と同じ文 */
  readonly description: string;
  readonly cta: CtaCopy;
  /** 追加リンク（副）→ #source-dl */
  readonly sourceDlLink: CtaCopy | null;
}

export interface FitGroupCopy {
  /** カードの見出し。カードが 1 枚のページは null */
  readonly title: string | null;
  /** 箇条書き（Lucide / check） */
  readonly items: readonly string[];
}

export interface ServiceDetailCopy {
  readonly slug: ServiceSlug;
  readonly h1: string;
  readonly breadcrumb: readonly BreadcrumbItem[];
  /** 導入ヒーロー */
  readonly hero: {
    readonly badge: string;
    /** 1 要素 ＝ 1 段落（Figma の組み方に合わせた） */
    readonly body: readonly string[];
    readonly cta: CtaCopy;
  };
  /** プラン（PricingCard）。カードの直下に TAX_NOTE */
  readonly plans: SectionCopy & { readonly cards: readonly PlanCardCopy[] };
  /** こんな方に向いています（見出しに Badge「要確認」） */
  readonly fit: SectionCopy & { readonly groups: readonly FitGroupCopy[] };
  readonly steps: StepsSection;
  /** 無料 DL ブロック（控えめ版。文言は SOURCE_DL_NEUTRAL）。環境構築のページだけ */
  readonly sourceDl: { readonly ctaId: CtaId } | null;
  readonly faq: FaqSection;
  /**
   * 関連記事（BlogCard ×3。ダミーの中身は blog.ts の blogCardSample、Badge の語は blog モジュールの BLOG_CATEGORIES の label）。
   * cardIntents は 3 枚の Badge の並び。Figma（47:8744）の表示は 3 枚とも「課題を知る」だが、仕様書 7-4（カテゴリの見立てを 3 種で示す）に合わせて 3 種にした
   */
  readonly related: SectionCopy & { readonly cardIntents: readonly SearchIntent[] };
  readonly banner: CtaBannerCopy;
}

const PLANS_HEADING = 'プラン';
const FIT_SECTION = { heading: 'こんな方に向いています', headingBadge: '要確認' } as const;
const FAQ_HEADING = 'よくある質問';
const RELATED = {
  heading: '関連する記事',
  cardIntents: ['latent', 'semi', 'explicit'],
} as const satisfies ServiceDetailCopy['related'];
const SERVICE_CTA_LABEL = 'このサービスを相談する';

const servicesCrumb = (label: string): readonly BreadcrumbItem[] => [
  { label: 'ホーム', href: '/' },
  { label: 'サービス', href: '/services' },
  { label },
];

// 4.3.1 環境構築
const ENVIRONMENT_SETUP_DETAIL: ServiceDetailCopy = {
  slug: 'environment-setup',
  h1: '環境構築：事業経営基盤を 1日で立ち上げます',
  breadcrumb: servicesCrumb('環境構築'),
  hero: {
    badge: 'ソースコード無料配布',
    // 2-4 カード 1 と同じ文
    body: [SERVICE_CARDS['environment-setup'].body],
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_environment_setup_hero',
      target: { type: 'contact', service: 'environment-setup' },
    },
  },
  plans: {
    heading: PLANS_HEADING,
    cards: [
      {
        key: 'environment-setup',
        badge: null,
        description: PRICING_DESCRIPTIONS['environment-setup'],
        cta: {
          label: SERVICE_CTA_LABEL,
          ctaId: 'consult_environment_setup_card',
          target: { type: 'contact', service: 'environment-setup' },
        },
        sourceDlLink: {
          label: SOURCE_DL_LABEL,
          ctaId: 'dl_environment_setup_card',
          target: { type: 'anchor', hash: '#source-dl' },
        },
      },
    ],
  },
  fit: {
    ...FIT_SECTION,
    groups: [
      {
        title: null,
        items: [
          'ソースコードは受け取ったが、構築に時間を取れない',
          'まず動く状態を見てから、使い方を決めたい',
          '自社のクラウドに置いて、社内から使いたい',
        ],
      },
    ],
  },
  steps: {
    heading: '進め方',
    desktopLayout: '2x2',
    items: [
      { title: 'ヒアリング', body: '構築先（クラウドまたはお客さまの端末）と、使うツールの範囲を伺います。' },
      { title: 'ご準備', body: '必要なアカウントと接続情報をご用意いただきます。' },
      { title: '構築', body: 'ソースコード一式を構築し、ひととおり動くことを確認します。' },
      { title: 'お引き渡し', body: '起動と停止の手順をお伝えし、運用を引き継ぎます。' },
    ],
  },
  sourceDl: { ctaId: 'dl_environment_setup_section' },
  faq: {
    heading: FAQ_HEADING,
    items: [
      {
        question: 'クラウドと手元の端末のどちらに構築できますか？',
        answer: 'どちらでも構築できます。ご希望に合わせてお選びください。',
      },
      {
        question: 'クラウドの利用料は料金に含まれますか？',
        answer: '含まれません。クラウド（サードパーティのライセンスを含む）の利用料は、お客さまのご負担です。',
      },
      {
        question: 'ソースコードが無料で公開されているのに、このサービスを使う意味は何ですか？',
        answer:
          '構築の作業を ComeGin が行う点です。ソースコードは公開し、構築の手順書も無料でお渡ししているため、ご自身で構築することもできます。',
      },
      {
        question: '構築した後の運用は誰が行いますか？',
        answer: 'お客さまです。運用を一緒に回したい場合はコンサルをご利用ください。',
      },
      {
        question: '契約の期間と解約を教えてください',
        answer:
          '業務委託基本契約書と発注書を取り交わします。契約期間は 1年で、自動更新です。解約は契約解除合意書のお申し出によります。',
      },
    ],
  },
  related: RELATED,
  banner: {
    title: 'どこに構築するかから、ご相談ください',
    body: '構築先が決まっていなくてもかまいません。相談は無料です。',
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_environment_setup_banner',
      target: { type: 'contact', service: 'environment-setup' },
    },
  },
};

// 4.3 受託開発（Figma で組んだテンプレートの例）
const DEVELOPMENT_DETAIL: ServiceDetailCopy = {
  slug: 'development',
  h1: '受託開発：バイブコーディングから要件定義〜運用保守まで',
  // 3-2
  breadcrumb: servicesCrumb('受託開発'),
  // 3-3
  hero: {
    badge: '受託開発',
    // 仕様書の 3 文を、Figma（46:9463）のとおり 1 段落に続けて組む
    body: [
      'プランは 2つです。『バイブコーディングのみ』は、短い期間で動くものを作ります。『要件定義〜運用保守』は、何を作るかの整理からリリース後の運用保守までを一貫して担います。',
    ],
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_development_hero',
      target: { type: 'contact', service: 'development' },
    },
  },
  // 3-4。Desktop 2 列、Mobile 1 列。同じ cta_id を 2 枚で使い、cta_clicked の service で分ける（§6.3）
  plans: {
    heading: PLANS_HEADING,
    cards: [
      {
        key: 'development-vibe',
        badge: null,
        description: PRICING_DESCRIPTIONS['development-vibe'],
        cta: {
          label: 'このプランで相談する',
          ctaId: 'consult_development_card',
          target: { type: 'contact', service: 'development-vibe' },
        },
        sourceDlLink: null,
      },
      {
        key: 'development-full',
        badge: '要件定義から一貫対応',
        description: PRICING_DESCRIPTIONS['development-full'],
        cta: {
          label: 'このプランで相談する',
          ctaId: 'consult_development_card',
          target: { type: 'contact', service: 'development-full' },
        },
        sourceDlLink: null,
      },
    ],
  },
  // 3-5。Card ×2（カード A・B に対応）
  fit: {
    ...FIT_SECTION,
    groups: [
      {
        title: 'バイブコーディングのみ',
        items: ['作りたいものの仕様が、ある程度まで決まっている', 'まずは動く試作品を短期間で手に入れたい'],
      },
      {
        title: '要件定義〜運用保守',
        items: ['何を作るべきかの整理から相談したい', 'リリース後の運用や保守まで任せたい'],
      },
    ],
  },
  // 3-6。要件定義〜運用保守のプランだけの段階（バイブコーディングのみの進め方は出さない）
  steps: {
    heading: '進め方（要件定義〜運用保守のプラン）',
    desktopLayout: '3+2',
    items: [
      {
        title: 'キックオフ',
        period: '契約〜1週間',
        body: '棚卸しで測った業務時間を基準値として確定し、何をもって成功とするかを書面で取り決めます。',
      },
      { title: '導入', period: '〜30日', body: '最初の 1業務を稼働させ、現場で実際に使われる状態にします。' },
      {
        title: '定着',
        period: '〜90日',
        body: '現場の声を集めて改修し、担当の方が手順書だけで操作できるようにします。',
      },
      {
        title: '効果測定',
        period: '90日',
        body: '基準値と同じ方法で測り直し、削減できた業務時間を経営者の方にご報告します。',
      },
      {
        title: '保守・拡大',
        period: '90日〜',
        body: `保守契約（${MAINTENANCE_PRICE}）に移り、次の業務へ広げます。`,
      },
    ],
  },
  sourceDl: null,
  // 3-7
  faq: {
    heading: FAQ_HEADING,
    items: [
      // 3-7 の見出しは仕様書に無く、Figma（47:8610）の「よくある質問」を採った
      {
        question: 'バイブコーディングとは何ですか？',
        answer: 'AI コーディングエージェントと対話しながら、短いサイクルで実装を進める開発のやり方です。',
      },
      {
        question: '『バイブコーディングのみ』には何が含まれますか？',
        answer: `含まれるのは、AI コーディングエージェントと対話しながら短いサイクルで実装し、動くものをお渡しするところまでです。要件定義と設計、テストと品質保証、インフラの構築とデプロイ、リリース後の運用保守は含まれません。これらも含めてお任せいただく場合は、要件定義〜運用保守（${DEVELOPMENT_FULL_PRICE}）をご利用ください。`,
      },
      {
        question: '期間が 60〜90日と幅があるのはなぜですか？',
        answer: '作るものの規模によって変わるためです。無料相談で内容を伺い、目安をお伝えします。',
      },
      {
        question: '開発したソースコードの権利はどうなりますか？',
        answer: '代金のお支払いを確認した時点で、開発したソースコードの著作権をお客さまに譲渡します。',
      },
    ],
  },
  // 3-8
  related: RELATED,
  // 3-9
  banner: {
    title: '作りたいものを、まずはお聞かせください',
    body: '仕様が固まっていなくてもかまいません。相談は無料です。',
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_development_banner',
      target: { type: 'contact', service: 'development' },
    },
  },
};

// 4.3.2 コンサル
const CONSULTING_DETAIL: ServiceDetailCopy = {
  slug: 'consulting',
  h1: 'コンサル：改善のループを、毎月一緒に回します',
  breadcrumb: servicesCrumb('コンサル'),
  hero: {
    badge: 'コンサル',
    body: [
      'KPI の設計、検索意図に合わせた記事と CTA の設計、月次の改善会議の運営を支援します。基盤を立ち上げた後、何を見て何を直すかを決め続ける部分をご一緒します。',
    ],
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_consulting_hero',
      target: { type: 'contact', service: 'consulting' },
    },
  },
  plans: {
    heading: PLANS_HEADING,
    cards: [
      {
        key: 'consulting',
        badge: null,
        description: PRICING_DESCRIPTIONS.consulting,
        cta: {
          label: SERVICE_CTA_LABEL,
          ctaId: 'consult_consulting_card',
          target: { type: 'contact', service: 'consulting' },
        },
        sourceDlLink: null,
      },
    ],
  },
  fit: {
    ...FIT_SECTION,
    groups: [
      {
        title: null,
        items: [
          '基盤は立ち上げたが、何を見て何を直すかが決まらない',
          '月次の改善会議を、続く形にしたい',
          '記事と CTA の設計を、相談しながら進めたい',
        ],
      },
    ],
  },
  steps: {
    heading: '進め方',
    desktopLayout: '3+2',
    items: [
      { title: '現状の確認', body: 'いまの計測と、記事・CTA の状態を確認します。' },
      { title: 'KPI の設計', body: '見る指標と、その数字の正本をそれぞれ 1つに決めます。' },
      { title: '施策の設計', body: '検索意図ごとの記事と CTA の出し分けを設計します。' },
      { title: '月次の改善会議', body: '観測結果を持ち寄り、次の 1か月に反映する改善を決めます。' },
      { title: '検証', body: '反映からおよそ 30日後に効果を測り、次の改善の根拠にします。' },
    ],
  },
  sourceDl: null,
  faq: {
    heading: FAQ_HEADING,
    items: [
      {
        question: '1回 4時間の使い方は決まっていますか？',
        answer: '決まっていません。月次の改善会議と、その準備と振り返りに充てる想定で、配分はご相談のうえ決めます。',
      },
      {
        question: '契約の期間と解約を教えてください',
        answer:
          'コンサルティング契約書と発注書を取り交わします。契約期間は 1か月で、自動更新です。解約は契約解除合意書のお申し出によります。',
      },
      {
        question: '基盤を構築していなくても依頼できますか？',
        answer: '無料相談で状況を伺います。先に環境構築からのほうがよい場合は、その旨をお伝えします。',
      },
      {
        question: '記事の執筆も依頼できますか？',
        answer: 'コンサルに含まれるのは設計と会議の運営の支援です。制作そのものを任せたい場合は受託開発をご利用ください。',
      },
    ],
  },
  related: RELATED,
  banner: {
    title: 'いま何を見ているかを、お聞かせください',
    body: '指標が決まっていない段階からご一緒します。相談は無料です。',
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_consulting_banner',
      target: { type: 'contact', service: 'consulting' },
    },
  },
};

// 4.3.3 業務提携
const PARTNERSHIP_DETAIL: ServiceDetailCopy = {
  slug: 'partnership',
  h1: '業務提携：福祉・介護・教育の事業者さまと、一緒に作ります',
  breadcrumb: servicesCrumb('業務提携'),
  hero: {
    badge: '福祉・介護・教育',
    // 2-4 カード 4・4-4 カード 5 と同じ文
    body: [PRICING_DESCRIPTIONS.partnership],
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_partnership_hero',
      target: { type: 'contact', service: 'partnership' },
    },
  },
  plans: {
    heading: PLANS_HEADING,
    cards: [
      {
        key: 'partnership',
        badge: null,
        description: PRICING_DESCRIPTIONS.partnership,
        cta: {
          label: SERVICE_CTA_LABEL,
          ctaId: 'consult_partnership_card',
          target: { type: 'contact', service: 'partnership' },
        },
        sourceDlLink: null,
      },
    ],
  },
  fit: {
    ...FIT_SECTION,
    groups: [
      {
        title: null,
        items: [
          '福祉・介護・教育の事業者として、提携して取り組みたい',
          '自社の業務に合う仕組みを、一緒に作る形で進めたい',
        ],
      },
    ],
  },
  steps: {
    heading: '進め方',
    desktopLayout: '2x2',
    items: [
      { title: '無料相談', body: '事業の内容と、取り組みたいことを伺います。' },
      {
        title: '条件のすり合わせ',
        body: '役割の分担、レベニューシェアによる回収の計画、成果の扱いを個別に決めます。',
      },
      { title: 'ご契約', body: '業務提携契約書と発注書を、電子署名で取り交わします。' },
      { title: '実施と振り返り', body: '進めながら、定期的に結果を一緒に確かめます。' },
    ],
  },
  sourceDl: null,
  faq: {
    heading: FAQ_HEADING,
    items: [
      {
        question: '福祉・介護・教育以外の事業者でも相談できますか？',
        answer:
          '業務提携は福祉・介護・教育事業を行う中小企業、社会福祉法人、非営利団体に限ります。環境構築、受託開発、コンサルは業界を限っていません。',
      },
      {
        question: '開発の費用はどう支払いますか？',
        answer: 'レベニューシェアで回収する計画を、ご相談のうえ個別に決めます。',
      },
      {
        question: 'クラウドの利用料はどうなりますか？',
        answer: 'クラウド（サードパーティのライセンスを含む）の利用料は、お客さまのご負担です。',
      },
      {
        question: '契約の期間と解約を教えてください',
        answer:
          '業務提携契約書と発注書を取り交わします。契約期間は 1年で、自動更新です。解約は契約解除合意書のお申し出によります。',
      },
    ],
  },
  related: RELATED,
  banner: {
    title: '取り組みたいことを、お聞かせください',
    body: '条件が決まっていない段階からご相談いただけます。相談は無料です。',
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_partnership_banner',
      target: { type: 'contact', service: 'partnership' },
    },
  },
};

/** services/[slug].astro の getStaticPaths はこの 4 件を回す */
export const SERVICE_DETAILS: Readonly<Record<ServiceSlug, ServiceDetailCopy>> = {
  'environment-setup': ENVIRONMENT_SETUP_DETAIL,
  development: DEVELOPMENT_DETAIL,
  consulting: CONSULTING_DETAIL,
  partnership: PARTNERSHIP_DETAIL,
};

// ---------------------------------------------------------------------------
// ページで使う組み立て（トップ・サービス一覧・サービス詳細・料金で共通）
// ---------------------------------------------------------------------------

/** CTA の行き先。/contact へは ?cta=・?from=（・?service=）を付ける（§6.3）。from はビルド時のパス */
export function ctaHref(cta: CtaCopy, from: string): string {
  return cta.target.type === 'anchor'
    ? cta.target.hash
    : contactHref({ cta: cta.ctaId, from, service: cta.target.service });
}

/** 価格の行（ServiceCard の価格の枠に渡す形）。金額・期間は §2（pricing.ts）から引く */
export interface ServiceCardPriceRow {
  readonly product: string;
  readonly price: string;
  readonly period: string;
}

/** サービスカード 1 枚分の価格の行と備考（showNote の行の備考だけを出す） */
export function serviceCardPrices(card: ServiceCardCopy): {
  prices: [ServiceCardPriceRow] | [ServiceCardPriceRow, ServiceCardPriceRow];
  note: string | undefined;
} {
  const rows = card.priceRows.map(({ key }) => {
    const { product, price, period } = PRICING[key];
    return { product, price, period };
  });
  if (rows.length < 1 || rows.length > 2) throw new Error(`サービスカード「${card.title}」の価格の行は 1〜2 行です。`);
  const noteRow = card.priceRows.find((row) => row.showNote);
  return {
    prices: rows as [ServiceCardPriceRow] | [ServiceCardPriceRow, ServiceCardPriceRow],
    note: noteRow ? (PRICING[noteRow.key].note ?? undefined) : undefined,
  };
}
