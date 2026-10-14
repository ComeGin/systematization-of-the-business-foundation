// 画面 1 トップ（/）の文言。01-content-spec.md §4.1 の 1-1〜1-11（1-4d は 2026-10-13 に追加）。
// 1-2 ヘッダー・1-12 フッター・1-13 Cookie 同意バナーは layout と consent が持つ。
// 文言は仕様書から一字一句写す。和欧間の半角スペースは仕様書のまま（計画書 P-2）。
// 金額は pricing.ts から読む（このファイルに料金表の金額を書かない）。
// 「（準備中）」などの印は消さない。架空の社名・人名・数値を足さない。

import {
  DEVELOPMENT_FULL_PRICE,
  ENVIRONMENT_SETUP_PERIOD,
  ENVIRONMENT_SETUP_PRICE,
  MAINTENANCE_PRICE,
} from "./pricing";
import type { BreakableHeading } from "@/modules/marketing-ui";
import type { CtaId } from "./cta";
import type { PhotoKey } from "@/modules/media";
import type {
  CtaBannerCopy,
  CtaCopy,
  FaqSection,
  LinkCopy,
  SourceDlCopy,
  StepCopy,
} from "./services";

/** Lucide のアイコン名（kebab-case）。部品側で lucide のコンポーネントに引き当てる */
export type LucideIconName = string;

export interface IconCardCopy {
  readonly icon: LucideIconName;
  readonly title: string;
  readonly body: string;
  /** 本文の直下の出典（Caption 12px、role/text-muted）。行ごとの配列 */
  readonly caption?: readonly string[];
}

const CONSULT_LABEL = "無料で相談する";

export const TOP = {
  // 1-1 告知バナー（AnnouncementBanner。ヘッダーの上。閉じるボタンなし）
  announcement: {
    /** Desktop だけ。Mobile では省く */
    badge: "無料公開中",
    /** Desktop の本文（仕様書の 2 文を 1 行に続けて組む。AnnouncementBanner の Text は 1 つ） */
    desktopBody:
      "ComeGin が使っている基盤のソースコードを、無料で公開しています。構築の手順書は、メールアドレスだけで受け取れます。",
    /** Mobile の本文（1 行に収める短縮版） */
    mobileBody: "ソースコード公開中・手順書を無料配布",
    /** Link。Lucide / arrow-right を右に */
    cta: {
      label: "受け取る",
      ctaId: "dl_top_banner",
      target: { type: "anchor", hash: "#source-dl" },
    } satisfies CtaCopy,
  },

  // 1-3 ヒーロー
  hero: {
    /**
     * h1 の上の 1 行。JP/Small（14px / 400 / 1.75）、色 role/text-brand（リンクではないので下線なし）。
     * サイト全体でここ 1 か所だけ。14px なら Desktop・Mobile とも 1 行に収まる
     * （収まらないときだけ「現場の言葉と、／技術の言葉を。」で割る。GL §2.4）
     */
    tagline: "現場の言葉と、技術の言葉を。",
    // 見出しの指定改行（H-19）。Desktop「…、／1人分の予算で業務を変える。」、Mobile「…、／1人分の予算で／業務を変える。」
    h1: {
      text: "社内に IT 人材がいなくても、1人分の予算で業務を変える。",
      segments: [
        { text: "社内に IT 人材がいなくても、", breakAfter: "both" },
        { text: "1人分の予算で", breakAfter: "mobile" },
        { text: "業務を変える。" },
      ],
    } satisfies BreakableHeading,
    /** h1 の直後の本文（3 文）。Figma（42:2949）のとおり 1 文 1 段落で組む */
    body: [
      "足りないのは予算ではなく、予算を使って業務に合わせられる人です。",
      "ComeGin は人を雇わず、外部委託もせず、その 1人分を引き受けます。",
      "福祉と IT の両方の現場で培った、再現性の高い作り方でお応えします。",
    ],
    /** 主。Primary / Large。Mobile は全幅で上 */
    primaryCta: {
      label: CONSULT_LABEL,
      ctaId: "consult_top_hero",
      target: { type: "contact" },
    } satisfies CtaCopy,
    /** 副。Ghost / Large、Lucide / download を左に */
    secondaryCta: {
      label: "ソースコードを無料 DL",
      ctaId: "dl_top_hero",
      target: { type: "anchor", hash: "#source-dl" },
    } satisfies CtaCopy,
    /** ボタンの下の小さい文字 */
    note: "相談は無料です。しつこい営業はいたしません。",
    /** 写真（右側。4:3）。Mobile は本文の下。写真と alt は media モジュールの PHOTOS（2026-10-14 に画像枠から差し替え） */
    photo: "workOfficeWheelchair" satisfies PhotoKey,
  },

  // 1-4a 業務理念と、それを実現する 5つの方法。Desktop は 3 列 ＋ 2 列（上段 1〜3、下段 4〜5）、Mobile 1 列
  philosophy: {
    /** h2 の上の 1 行。JP/Small、色 role/text-brand（1-3 のタグラインと同じ組み方） */
    eyebrow: "ComeGin の業務理念",
    /** 創業計画書 第1項の業務理念と一字一句同じ（句点まで） */
    // 見出しの指定改行（H-19）。Desktop「…、／1人分の予算で実現する業務改善。」、Mobile「…、／1人分の予算で実現する／業務改善。」
    heading: {
      text: "社内に IT 人材がいなくても、1人分の予算で実現する業務改善。",
      segments: [
        { text: "社内に IT 人材がいなくても、", breakAfter: "both" },
        { text: "1人分の予算で実現する", breakAfter: "mobile" },
        { text: "業務改善。" },
      ],
    } satisfies BreakableHeading,
    lead: "この業務理念を、次の 5つの方法で実現します。",
    cards: [
      {
        icon: "user-round-check",
        title: "人を雇いません",
        body: "外部委託もしません。要件定義から運用保守まで、すべての責任を ComeGin が一人で負います。",
      },
      {
        icon: "repeat",
        title: "再現性の高い作り方",
        body: "福祉と IT の両方の現場経験から、聞き取りから定着までを同じ手順で繰り返せる形にしています。",
      },
      {
        icon: "coins",
        title: "採掘への協力を、ポイントで還元",
        body: "公開しているソースコードの利用者が、希望した場合だけ、サーバの余った処理能力で暗号資産の採掘に協力できます。協力分は、ご発注の代金に使えるポイントで還元します（準備中）。いつでも止められます。",
      },
      {
        icon: "gift",
        title: "自社のシステムは、無料で公開",
        body: "ComeGin が自社で開発したシステムは、ソースコードを無料で公開します。お客さまのために開発したシステムは、公開しません。",
      },
      {
        // kit に無ければ天秤・上限を表す近いアイコンで代える（§4.1 の 1-4a）
        icon: "scale",
        title: "利益は 1人分まで",
        body: "代表 1人が暮らし、事業を続けられるだけの利益を上限にします。それを超える見込みが立ったら、新しいご契約の価格を下げ、無料で公開するシステムの開発に回します。",
      },
    ] satisfies readonly IconCardCopy[],
  },

  // 1-4b こんなことが起きていませんか。Desktop 3 列、Mobile 1 列
  // 3 枚はサービスと 1 対 1（カード 1 ＝ 受託開発、2 ＝ 環境構築、3 ＝ コンサル）
  problems: {
    heading: "こんなことが起きていませんか",
    cards: [
      {
        icon: "file-text",
        title: "同じことを、二度書いている",
        body: "業務ソフトに入れた内容を、請求や報告のために別の様式へ書き写している。",
      },
      {
        icon: "unplug",
        title: "問い合わせが電話だけで、記録が残らない",
        body: "商談や相談の連絡が電話とメールに散らばり、誰にいつ何を伝えたかを後から辿れない。",
      },
      {
        icon: "user-round",
        title: "相談できる相手が、社内にいない",
        body: "何をどう直せばよいかを判断できる人がいないため、提案を受けても良し悪しを決められない。",
      },
    ] satisfies readonly IconCardCopy[],
  },

  // 1-4c 選ばれる理由（画面の見出しは「ComeGin がお約束すること」）。Desktop 3 列 ×2 段、Mobile 1 列
  // カード群の直下に TAX_NOTE（カード 1 が料金からの金額を出すため）
  promises: {
    heading: "ComeGin がお約束すること",
    lead: "費用、進め方、成果物の扱いについて、次の 6つをお約束します。",
    cards: [
      {
        icon: "wallet",
        title: "IT 人材 1人分より、低い予算で",
        // 516.6万円は統計からの算出値、285万円は料金表からの試算（料金表の 1 行ではないので数字のまま置く）
        body: "IT 人材を 1人雇うと、年収だけで平均 516.6万円かかります。たとえば受託開発 3か月と保守 9か月なら、ComeGin は 1年で 285万円（税別）です。",
        caption: [
          "出典: 厚生労働省「令和6年賃金構造基本統計調査」（ソフトウェア作成者・企業規模 10〜99人）",
          "年収は月の給与の 12か月分と年間賞与の合計で、法定福利費と採用費は含みません。",
          "285万円は、ComeGin の料金表からの試算です。",
          `受託開発 ${DEVELOPMENT_FULL_PRICE} × 3か月と、保守 ${MAINTENANCE_PRICE} × 9か月の合計です。`,
        ],
      },
      {
        icon: "map-pin",
        title: "現場に伺ってから作ります",
        body: "現場に伺って業務を観察し、現場とのずれが少ないシステムを作ります。",
      },
      {
        icon: "ruler",
        title: "効果を、数字でお見せします",
        body: "着手の前に業務時間の基準値を測り、導入の後に同じ方法で測り直してお見せします。",
      },
      {
        icon: "key-round",
        title: "契約が終わっても、使い続けられます",
        body: "開発したシステムの著作権は、代金のお支払いを確認した時点でお客さまに譲渡します。ほかの開発会社や社内に、そのまま引き継げます。",
      },
      {
        icon: "target",
        title: "受託開発は、常に 1社だけ",
        body: "同時にお受けする受託開発は 1社だけです。その 1社に、ComeGin の稼働を集中させます。",
      },
      {
        icon: "handshake",
        title: "使い方の設計まで、伴走します",
        body: "ComeGin が自社で使う事業経営基盤を、無償でお使いいただけます。マーケティングから事業管理まで、使い方の設計をご一緒します。",
      },
    ] satisfies readonly IconCardCopy[],
  },

  // 1-4d 体験の約束（2026-10-13 に新設。創業計画書 第3項「体験の約束」の 3 つの軸）。Desktop 3 列、Mobile 1 列
  // 1-4c（バリュープロポジション）とは別の表なので、カードを混ぜない。裏付けの数字は画面に出さない（§4.1 の 1-4d）
  experience: {
    /** h2 の上の 1 行。JP/Small、色 role/text-brand（1-4a の小見出しと同じ組み方） */
    eyebrow: "体験のお約束",
    // 創業計画書 第3項の一言を句点なしでそのまま。Desktop「…見え、／使い始めて迷わず、辞めるときに困らない」、
    // Mobile「…見え、／使い始めて迷わず、／辞めるときに困らない」
    heading: {
      text: "買う前に値段と効果が見え、使い始めて迷わず、辞めるときに困らない",
      segments: [
        { text: "買う前に値段と効果が見え、", breakAfter: "both" },
        { text: "使い始めて迷わず、", breakAfter: "mobile" },
        { text: "辞めるときに困らない" },
      ],
    } satisfies BreakableHeading,
    lead: "ご契約の前から、使っている間、辞めるときまで。お客さまがそれぞれの場面で経験することを、先にお約束します。",
    cards: [
      {
        icon: "door-open",
        title: "辞め方を、契約の前に決めておきます",
        body: "解約の条件と、解約のときにお渡しするものを、見積書と契約書に書きます。お渡しするのは、ソースコード、CSV などの標準形式のデータ、手順書、設定情報です。違約金はいただきません。料金を改定しても、締結済みのご契約には適用しません。",
      },
      {
        icon: "smartphone",
        title: "新しいアプリを、覚えなくて済みます",
        body: "LINE や Excel、紙の帳票など、現場がいま使っているものを入口にして、その裏に仕組みを作ります。新しい画面を足すときは、現場で使っている言葉を、そのまま画面の言葉にします。",
      },
      {
        icon: "accessibility",
        title: "障がいのある方も、同じ画面で働けます",
        body: "受託開発の要件定義〜運用保守のプランで納品する画面は、ウェブアクセシビリティの規格に沿って作ります。JIS X 8341-3:2016 の適合レベル AA を標準の仕様とし、追加の料金はいただきません。",
      },
    ] satisfies readonly IconCardCopy[],
  },

  // 1-5 仕組み。Desktop は 3 列 ＋ 2 列（段の中は arrow-right）、Mobile 縦 1 列（arrow-down）
  loop: {
    /** セクション見出しの上のつなぎの 1 文 */
    bridge: "ComeGin が自分の事業で回している仕組みを、そのままお渡しします。",
    heading: "観測から検証までを、ひとつのループに",
    lead: "ComeGin の事業経営基盤は、次の 5つのステップを繰り返します。AI エージェントが観測と改善案の下書きを担います。採用するかどうかは人が決めます。ここは自動化しません。",
    steps: [
      {
        title: "観測",
        body: "検索順位、流入、問い合わせ、表示速度などのデータを、毎日決まった範囲で集めます。",
      },
      {
        title: "提案",
        body: "AI エージェントが、観測結果から改善案を下書きします。根拠のデータと、元に戻す手順を添えます。",
      },
      {
        title: "承認",
        body: "改善案を採用するかどうかは、人が決めます。この判断は自動化しません。",
      },
      {
        title: "反映",
        body: "承認された改善だけを、サイトの記事や問い合わせの導線に反映します。",
      },
      {
        title: "検証",
        body: "反映からおよそ 30日後に効果を測り、その結果を次の改善の根拠にします。",
      },
    ] satisfies readonly StepCopy[],
    /** 約束の枠（Card。面は白 ＋ border） */
    guardrails: {
      heading: "暴走させないための、設計上の約束",
      items: [
        "記事の公開や配信など、外部に出る操作は人が行います。",
        "1か月に反映する改善は 3件まで。どの変更が効いたのかを後から説明できるようにします。",
        "SEO の品質スコアが基準を下回ったら、改善の反映を止めます。",
        "すべての改善案に、元に戻す手順を先に書きます。",
      ],
    },
  },

  // 1-6 使うツール（Badge Outline ×10 を折り返して並べる。ロゴは使わない）
  tools: {
    heading: "使うツール",
    lead: "用途ごとに実績のあるツールを組み合わせ、データの正本を用途ごとに 1つに決めてつなぎます。",
    badges: [
      "Astro（サイト）",
      "Strapi（CMS）",
      "Mautic（MA）",
      "Google アナリティクス（アクセス解析）",
      "PostHog（行動分析・AB テスト）",
      "Chatwoot（チャット）",
      "n8n（ワークフロー）",
      "OpenSEO（検索市場調査）",
      "Google Search Console",
      "Lighthouse CI（品質監査）",
    ],
  },

  // 1-7 サービス。カードの中身は services.ts の SERVICE_CARDS（2-4 と共有）。Desktop 2 列 ×2 段、Mobile 1 列
  // カード群の直下に TAX_NOTE
  services: {
    heading: "サービス",
    // 仕様書の 2 文を、Figma（42:3143）のとおり 1 段落に続けて組む
    lead: "自分で立ち上げたい方から、作り込みと運用まで任せたい方まで、4つの関わり方があります。二度書き、問い合わせの記録、相談相手。この 3つに、それぞれ対応します。",
    /** 環境構築のカードの「ソースコードを無料 DL」の cta_id（サービス一覧は dl_services_card） */
    sourceDlCtaId: "dl_top_card" satisfies CtaId,
    /** セクション末尾のリンク（CTA ではない） */
    pricingLink: {
      label: "料金の一覧を見る",
      href: "/pricing",
    } satisfies LinkCopy,
  },

  // 1-8 導入事例（ダミー）。見出しの右に Badge「準備中」
  cases: {
    heading: "導入事例",
    headingBadge: "準備中",
    lead: "導入事例とお客さまの声は、掲載の許可をいただいたものから順に公開します。現在は準備中です。",
    /** ロゴ枠 ×6（Desktop 6 列、Mobile 3 列 ×2 行） */
    logoPlaceholder: "ロゴ（準備中）",
    logoCount: 6,
    /** お客さまの声 ×3。人名・社名・肩書き・星の数を入れない */
    // badge は仕様書に無く、Figma（42:3741）の印「準備中」を採った
    testimonial: {
      badge: "準備中",
      title: "お客さまの声（準備中）",
      body: "掲載準備中です。",
    },
    testimonialCount: 3,
    /** 実績数値 ×3 */
    stats: [
      { label: "導入社数", value: "—", note: "公開準備中" },
      { label: "公開記事数", value: "—", note: "公開準備中" },
      { label: "改善の反映件数", value: "—", note: "公開準備中" },
    ],
  },

  // 1-9 無料 DL ブロック（控えめ版。id="source-dl"）。トップ専用の文言（中立版は services.ts の SOURCE_DL_NEUTRAL）
  // ボタン・リンクの文言は部品（forms の SourceDownloadBlock）が持つ
  sourceDl: {
    // 本文は Figma（42:3791）のとおり 1 文ずつ行を分けて組む
    copy: {
      title: "自分の手で立ち上げたい方へ、ソースコードを無料で公開しています",
      body: [
        "公開しているのは、ComeGin が自分の事業で使っている基盤一式です。",
        "構築の手順書は、メールアドレスを入力するとお受け取りいただけます。",
        `構築を任せたい場合は、環境構築サービス（${ENVIRONMENT_SETUP_PRICE}・${ENVIRONMENT_SETUP_PERIOD}、税別）もご利用いただけます。`,
      ],
    } satisfies SourceDlCopy,
    ctaId: "dl_top_section" satisfies CtaId,
  },

  // 1-10 よくある質問（最初の 1 件だけ開いた状態）
  faq: {
    heading: "よくある質問",
    items: [
      {
        question: "ソースコードは本当に無料ですか？",
        answer:
          "はい。ComeGin が自社で開発したシステムは、ソースコードを無料で公開しています。お客さまのために開発したシステムは公開しません。構築の手順書は、メールアドレスだけで受け取れます。ご自身での構築が難しい場合は、環境構築サービスをご利用ください。",
      },
      {
        question: "AI が勝手にサイトを書き換えることはありませんか？",
        answer:
          "ありません。AI エージェントが行うのは、観測、改善案の作成、記事の下書きまでです。記事の公開や配信など外部に出る操作は、人が承認してから行います。",
      },
      { question: "料金は税込ですか？", answer: "表示価格はすべて税別です。" },
      {
        question: "業務提携の対象を教えてください",
        answer:
          "福祉・介護・教育事業を行う中小企業、社会福祉法人、非営利団体の皆さまです。開発の費用はレベニューシェアで回収する計画を、ご相談のうえ個別に決めます。",
      },
      {
        question: "採掘への協力は必須ですか？",
        answer:
          "いいえ。無料で公開しているソースコードをお使いの方が、ご希望の場合だけ有効にできます。有効にしない限り、採掘は行いません。いつでも止められます。還元するポイントはご発注の代金にだけ使え、譲渡や換金はできません。開始は準備中です。",
      },
      {
        question: "無料相談では何をしますか？",
        answer:
          "ComeGin が現場に伺い、4時間で業務を棚卸しします。経営者の方へのヒアリング、現場の観察、業務時間の棚卸し、振り返りの順に進めます。振り返りでは、費用の概算もお伝えします。結果は『業務棚卸しレポート』にまとめ、当日か翌営業日にお渡しします。",
      },
    ],
  } satisfies FaqSection,
  /** 1-10 で最初から開いておく項目の添字 */
  faqDefaultOpenIndex: 0,

  // 1-11 CTA バナー（主 CTA。Desktop は見出しと本文が左・ボタンが右、Mobile は縦積みでボタン全幅）
  banner: {
    title: "どこに時間がかかっているかを、一緒に数えます",
    body: "現場に伺い、業務時間を数えるところから始めます。相談は無料です。",
    cta: {
      label: CONSULT_LABEL,
      ctaId: "consult_top_banner",
      target: { type: "contact" },
    },
  } satisfies CtaBannerCopy,
} as const;
