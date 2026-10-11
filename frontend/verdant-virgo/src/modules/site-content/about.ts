// 画面 5 会社概要（/about）の文言。正本は 01-content-spec.md §4.5（2026-10-08 改訂）。
// 和欧間の半角スペースは仕様書のまま入れる（計画 P-2。CSS の text-autospace は使わない）。
// 料金・SEO メタ・cta_id はここに置かない（§2 は pricing.ts、§7 は seo.ts、§6.3 は cta.ts）。

import { link, type RichText } from "@/modules/legal";
import type { BreakableHeading } from "@/modules/marketing-ui";

// 改行位置の指定がある見出しの型（H-19）の正本は marketing-ui。top.ts がここから import しているので再エクスポートする
export type { BreakableHeading, LineBreakAt } from "@/modules/marketing-ui";

export interface IconCardCopy {
  /** lucide のアイコン名 */
  readonly icon: string;
  readonly title: string;
  readonly body: string;
}

export interface TableRowCopy {
  readonly label: string;
  readonly value: RichText;
}

// 5-5a と 8-7（ブログ記事の著者カード）で一字一句同じにする 2 文（§4.5 5-5a・§4.8 8-7 の ⚠）。
// 片方だけ直せないよう、1 か所に置いて両方から参照する。
const careerSentences = [
  "介護事業者の現場に入り、社内の業務改善システムを構築しました（2025年5月〜2026年11月）。",
  "担当したのは、業務課題の特定から、設計、実装、デプロイ、現場への定着までです。",
] as const;

export const about = {
  path: "/about",

  // 5-2 パンくず
  breadcrumb: [{ label: "ホーム", href: "/" }, { label: "会社概要" }],

  // 5-3 導入ヒーロー（HERO）
  hero: {
    badge: "会社概要",
    // ビジョン（GL v1.3 §2.3）。Desktop 2 行／Mobile 4 行（Mobile は 1 行 全角 11 字以内）
    h1: {
      text: "障がいの有無にかかわらず、働く者に等しく賃金が渡る社会。",
      segments: [
        { text: "障がいの有無に", breakAfter: "mobile" },
        { text: "かかわらず、", breakAfter: "both" },
        { text: "働く者に等しく", breakAfter: "mobile" },
        { text: "賃金が渡る社会。" },
      ],
    } satisfies BreakableHeading,
    // 4 文。最後の文（「業界を限らずお受けしています」）は削らない（§4.5 の ⚠。D-5 の解釈を支える）
    body: [
      "ComeGin は、代表 1名の個人事業です。",
      "人を雇わず、外部委託もせず、要件定義から運用保守まですべての責任を一人で負います。",
      "業務の話と技術の話の間に翻訳ロスが生じません。",
      "福祉の現場を起点にしていますが、環境構築・受託開発・コンサルは業界を限らずお受けしています。",
    ],
    // 本文の下、引用の体裁。小見出しは Small・role/text-brand
    mission: {
      label: "ミッション",
      quote: "社内に IT がいなくても、1人分の予算で業務を変える。",
      notes: [
        "業務改善の仕事で積んだ実績と収益を、福祉・介護・教育の事業者さまとの業務提携に注ぎます。",
        "工賃は事業所の収益から支払われます。だから、先に事業所の収益力を上げます。",
      ],
    },
    // Desktop のみ右側。Mobile は置かない
    imagePlaceholder: "画像（準備中）",
  },

  // 5-4 運営方針（CONTENT）。Desktop 2 列 ×2 段、Mobile 1 列。並びは GL の番号順（1・2・3・6）
  values: {
    heading: "大切にしていること",
    cards: [
      {
        icon: "footprints",
        title: "現場から始める",
        body: "判断の出発点は、技術のトレンドではなく、現場の業務です。先に製品を決めて、現場をそれに合わせることはしません。",
      },
      {
        icon: "file-check",
        title: "一次資料で語る",
        body: "数字は省庁・公的研究機関・公益法人の公表資料と、上場企業の開示資料に限って引用し、出典と年度を添えます。業界メディアの孫引きはしません。",
      },
      {
        icon: "messages-square",
        title: "翻訳ロスをつくらない",
        body: "聞く人と作る人を分けません。お客さまの言葉を、そのまま要件に落とします。",
      },
      {
        // kit に無ければ近い意味のものに代える（§4.5 5-4）
        icon: "lock-open",
        title: "囲い込まない",
        body: "契約が終わっても使い続けられる形で納め、権利や保守でお客さまを縛りません。自社で開発したシステムはソースコードを公開し、お客さまのシステムは著作権ごとお渡しします。",
      },
    ] satisfies readonly IconCardCopy[],
  },

  // 5-5a これまでにやってきたこと（TRUST）。面は白＋border
  career: {
    heading: "介護事業の現場に入って、作ってきました",
    body: [
      ...careerSentences,
      "職種はフォワードデプロイドエンジニア（FDE）、現場に入って作る技術者です。",
    ],
    note: "事業者名は、掲載の許可をいただいたものから順に公開します。",
  },

  // 5-5b 自社での運用（TRUST）。「運用しています」とは書かない（C7）
  selfOperation: {
    heading: "この基盤は、ComeGin 自身のために作りました",
    body: [
      "このサイトの記事、問い合わせ、チャットは、ここで紹介している事業経営基盤の上で運用するために設計しています。",
      "運用の結果は、準備が整いしだいブログで公開します。",
    ],
    badge: "運用実績（準備中）",
  },

  // 5-6 会社情報（FOUND）。Mobile も 2 列の表（項目列 96px 程度）
  company: {
    heading: "会社情報",
    columns: ["項目", "内容"],
    rows: [
      { label: "会社名", value: "ComeGin" },
      { label: "代表者", value: "亀谷 銀大" },
      // 原文のまま（番地と建物名の間は半角スペース 1 個）
      {
        label: "所在地",
        value: "大阪府大阪市城東区蒲生4-19-3 ロイヤルアシュリー蒲生502",
      },
      { label: "設立", value: "2026年9月27日" },
      // GL v1.3 §3.4 の短縮の言い方。「／」の前後に空白を入れない（C21）
      {
        label: "事業内容",
        value: "現場の業務改善／システム開発・IT コンサルティング",
      },
      { label: "電話番号", value: "080-5257-9787" },
      { label: "メールアドレス", value: "kamegin4@comegin.com" },
      // CTA ではないページ間のリンク（§6.3 の cta_id を持たない）。?from= はフォームの page_url に渡す（DD-02 5.3。2026-10-09 リード判断）
      { label: "お問い合わせ", value: [link("無料相談フォーム", "/contact?from=/about")] },
      // 法人でない場合は「法人番号」の行を削除する（10.1 の U11）
      { label: "法人番号", value: "【要記入】" },
      { label: "適格請求書発行事業者の登録番号", value: "【要記入】" },
    ] satisfies readonly TableRowCopy[],
  },

  // 5-7 メンバー（TRUST、ダミー）。人名・肩書きを入れない。
  // 「Card ×2 に『画像（準備中）』と『メンバー紹介（準備中）』」は、Figma（45:2592）では 2 枚とも両方を持つ
  members: {
    heading: "メンバー",
    body: "メンバー紹介（準備中）",
    cards: [
      { image: "画像（準備中）", body: "メンバー紹介（準備中）" },
      { image: "画像（準備中）", body: "メンバー紹介（準備中）" },
    ],
  },

  // 5-8 CTA バナー（CONV、主）。§6.3 の #21 consult_about_banner
  ctaBanner: {
    heading: "考え方に共感いただけたら、まずはお話ししましょう",
    body: "いまの体制のままで何ができるかを一緒に考えます。相談は無料です。",
    button: "無料で相談する",
  },
} as const;

// 8-7 ブログ記事の著者カード（TRUST）。FDE の職種の説明は 5-5a にだけ置く
export const author = {
  imagePlaceholder: "画像（準備中）",
  name: "亀谷 銀大",
  bio: ["ComeGin 代表。", ...careerSentences],
} as const;
