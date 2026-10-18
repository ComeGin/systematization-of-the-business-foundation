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
import type { PhotoKey } from '@/modules/media';
import { contactHref, type CtaId, type ServiceInterest } from './cta';

// ---------------------------------------------------------------------------
// 文言ファイルの共通の型（top.ts・pricing.ts も使う）
// ---------------------------------------------------------------------------


/** CTA の行き先。/contact へのリンクの ?cta=・?from= はページ側で contactHref() が付ける */
export type CtaTarget =
  | { readonly type: 'contact'; readonly service?: ServiceInterest }
  // '/#source-dl' はトップの無料 DL ブロック。ページの中にブロックが無い画面で使う（JS が動けば source-dl の動きになる）
  | { readonly type: 'anchor'; readonly hash: '#source-dl' | '/#source-dl' };

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
// 無料 DL ブロック
// ---------------------------------------------------------------------------

// 無料 DL ブロック（forms の SourceDownloadBlock）はトップ（1-9。文言は top.ts）とブログ（7-5・8-8。blog.ts）だけに置く。
// 2026-10-18 にユーザー判断で、サービス一覧（2-7）・料金（4-7）・環境構築の詳細に置いていた中立版をやめた。
// 「ソースコードを無料 DL」の CTA が zip のダウンロードと無料相談への遷移になり、無料相談と役目が重なるため。主 CTA は無料相談。

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
   * 追加リンク（副）「ソースコードを無料 DL」（Link、Lucide / download）→ #source-dl（一覧はブロックが無いのでトップの /#source-dl）。
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
    'ComeGin のサービスは 4つです。ソースコードを使ってご自身で立ち上げる、構築を任せる、自社向けに作り込む、DX の進め方を一緒に決める。いまの状況に合わせてお選びください。',
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
      { situation: 'DX を何から進めるか、一緒に決めてほしい', recommend: 'コンサル' },
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
  // 2-8 CTA バナー
  banner: {
    title: 'どのサービスが合うか、一緒に考えます',
    body: '迷っている段階でもかまいません。相談は無料です。',
    cta: { label: CONSULT_LABEL, ctaId: 'consult_services_banner', target: { type: 'contact' } },
  } satisfies CtaBannerCopy,
} as const;

// ---------------------------------------------------------------------------
// 画面 3 サービス詳細（/services/<slug>）。§4.3・§4.3+
// 枠: パンくず → 導入ヒーロー → プラン → こんな方に → 進め方
//     → よくある質問 → 関連記事 → CTA バナー（無料 DL ブロックは置かない。2026-10-18）
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
    /** 右側の写真（Desktop は右 480px、Mobile は本文の下）。写真と alt は media モジュールの PHOTOS（2026-10-14 に追加） */
    readonly photo: PhotoKey;
  };
  /**
   * 写真の並び（Desktop 3 列、Mobile 1 列。写真の下に短いラベル）。業務提携のページだけ（2026-10-14 に追加）。
   * ヒーローの直後に置き、対象の事業（福祉・介護・教育）を写真で示す
   */
  readonly gallery?: SectionCopy & { readonly items: readonly { readonly photo: PhotoKey; readonly label: string }[] };
  /** プラン（PricingCard）。カードの直下に TAX_NOTE */
  readonly plans: SectionCopy & { readonly cards: readonly PlanCardCopy[] };
  /** こんな方に向いています（見出しに Badge「要確認」） */
  readonly fit: SectionCopy & { readonly groups: readonly FitGroupCopy[] };
  readonly steps: StepsSection;
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
    photo: 'techSmartwatch',
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
          target: { type: 'anchor', hash: '/#source-dl' },
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
        answer: 'お客さまです。基盤を使った DX の進め方を一緒に決めたい場合は、コンサルをご利用ください。',
      },
      {
        question: '契約の期間と解約を教えてください',
        answer:
          '業務委託基本契約書と発注書を取り交わします。契約期間は 1年で、自動更新です。解約は契約解除合意書のお申し出によります。お申し出は、解約する月の前月末までにお願いします。違約金はいただきません。料金を改定しても、締結済みのご契約には適用しません。',
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
    photo: 'techSmartglasses',
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
        body: '現場の声を集めて改修します。研修を行い、担当の方が手順書だけで操作できるようにします。',
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
      {
        question: '『バイブコーディングのみ』の契約の期間と解約を教えてください',
        answer:
          '業務委託基本契約書と発注書を取り交わします。契約期間は 1年で、自動更新です。解約は契約解除合意書のお申し出によります。',
      },
      {
        question: '解約するときは、どうなりますか？',
        answer:
          '違約金はいただきません。解約のお申し出は、解約する月の前月末までにお願いします。解約のときは、ソースコード、CSV などの標準形式のデータ、手順書、設定情報をお渡しします。ほかの開発会社や社内に、そのまま引き継げます。',
      },
      {
        question: '研修や手順書には、別の料金がかかりますか？',
        answer:
          'かかりません。要件定義〜運用保守のプランでは、研修と手順書を料金に含みます。最初の 1業務から始め、段階的に広げます。',
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

// 4.3.2 コンサル（2026-10-14 に内容を差し替え。このソースコードの運用ではなく、DX 推進を主軸にする。
// バイブコーディングなら作って確かめるまでの工数が小さく済む点を軸にする。「初回相談は無料」は無料相談と重なるので書かない）
// 2026-10-18 にユーザー判断で役割分担を明記: ComeGin は調査と既存の知見を提供し、実務（棚卸し・判断・試作・検証・定着）はお客さまが担う
const CONSULTING_DETAIL: ServiceDetailCopy = {
  slug: 'consulting',
  h1: 'コンサル：DX を、小さく作って確かめながら進めます',
  breadcrumb: servicesCrumb('コンサル'),
  hero: {
    badge: 'DX 推進',
    body: [
      'DX の推進を、計画書づくりで終わらせないための伴走です。ComeGin は、業務に合うツールや進め方の調査と、バイブコーディング（AI コーディングエージェントと対話しながら作るやり方）の知見をご提供します。',
      '業務の棚卸し、どの業務から置き換えるかの判断、試作と現場での検証、社内への定着といった実務は、お客さまに進めていただきます。1回 4時間で、調べた結果と知見をもとに、その進め方を一緒に確かめます。',
    ],
    cta: {
      label: CONSULT_LABEL,
      ctaId: 'consult_consulting_hero',
      target: { type: 'contact', service: 'consulting' },
    },
    photo: 'techVr',
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
          'DX を進めたいが、何から手を付ければよいかが決まらない',
          '開発会社に頼む前に、まず小さく作って効果を確かめたい',
          '社内に IT 人材がいないまま、DX の判断をしなければならない',
        ],
      },
    ],
  },
  steps: {
    heading: '進め方',
    desktopLayout: '3+2',
    items: [
      {
        title: '業務の棚卸し',
        body: 'お客さまが業務ごとの時間と手順を数えます。ComeGin は、置き換えの候補になる事例とツールを調べてお伝えします。',
      },
      {
        title: '優先順位づけ',
        body: '効果と手間の見込みから、最初に手を付ける業務をお客さまが 1つ決めます。判断の材料は ComeGin がそろえます。',
      },
      {
        title: '小さく試作',
        body: 'お客さまがバイブコーディングで、その業務の試作品を作ります。ComeGin は、作り方とつまずきやすい点をお伝えします。',
      },
      {
        title: '現場で検証',
        body: '試作品を現場で使い、業務時間がどれだけ減るかをお客さまが測ります。測り方は ComeGin がご提案します。',
      },
      {
        title: '定着と次の一手',
        body: '効果を確かめられたものをお客さまが社内に定着させ、次に置き換える業務を決めます。ComeGin は、ほかの事例をもとに助言します。',
      },
    ],
  },
  faq: {
    heading: FAQ_HEADING,
    items: [
      {
        question: '1回 4時間の使い方は決まっていますか？',
        answer: '決まっていません。調べた結果のご報告、棚卸しや試作、検証の振り返りなど、その時点で必要なことに充てます。配分はご相談のうえ決めます。',
      },
      {
        question: 'バイブコーディングとは何ですか？',
        answer:
          'AI コーディングエージェントと対話しながら、短いサイクルで実装を進める開発のやり方です。仕様を固めてから開発するやり方に比べて、試作品ができるまでの工数を小さく抑えられます。',
      },
      {
        question: '社内に IT 人材がいなくても依頼できますか？',
        answer: 'はい。社内に IT の担当者がいない企業さまを前提にしています。専門用語に頼らず、現場の言葉で進めます。',
      },
      {
        question: '受託開発とは何が違いますか？',
        answer:
          'コンサルでは、ComeGin が調査と知見をご提供し、DX の進め方の判断や試作などの実務はお客さまに進めていただきます。開発の実務を任せたい場合は、受託開発をご利用ください。',
      },
      {
        question: '契約の期間と解約を教えてください',
        answer:
          'コンサルティング契約書と発注書を取り交わします。契約期間は 1か月で、自動更新です。解約は契約解除合意書のお申し出によります。お申し出は、解約する月の前月末までにお願いします。違約金はいただきません。料金を改定しても、締結済みのご契約には適用しません。',
      },
    ],
  },
  related: RELATED,
  banner: {
    title: 'DX を、どこから始めるかをお聞かせください',
    body: 'まだ何も決まっていない段階からご一緒します。相談は無料です。',
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
    photo: 'careHands',
  },
  gallery: {
    heading: '提携する事業',
    items: [
      { photo: 'welfareWorkSupport', label: '福祉（障がい福祉・就労支援）' },
      { photo: 'careRecreation', label: '介護' },
      { photo: 'educationChildren', label: '教育（児童・放課後の支援）' },
    ],
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
