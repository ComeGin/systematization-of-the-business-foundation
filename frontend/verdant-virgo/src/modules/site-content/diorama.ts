// ヒーローの「基盤の模型」の文言（diorama モジュールの DioramaHero・DioramaPanel が読む）。2026-10-28。
// 設計は docs/superpowers/specs/2026-10-28-hero-diorama-design.md §6.3・§7。部品は文言の既定値を持たない（H-16）。
// 読者は IT 人材のいない中小企業の経営者（GL v1.3 §2.8 のペルソナ A・B）。部品の名前は日常の言葉にし、実際の製品名は productNote で添える。
// 製品名は 1-6「使うツール」（top.ts の tools）と同じ書き方にそろえる。
// 「観測・提案・承認・反映」の言い方は 1-5「仕組み」（top.ts の loop）と同じ。承認は人が行い、自動化しないことを崩さない。
import type { PartId } from "@/modules/diorama/client";

export interface DioramaPartCopy {
  /** 部品の名前（ボタンの名前・パネルの見出し） */
  name: string;
  /** 何をしているか（1〜2 文） */
  body: string;
  /** 実際の製品・仕組みの名前。無ければ null */
  productNote: string | null;
  /** 関連するページへのリンク。無ければ null */
  link: { label: string; href: string } | null;
}

export const DIORAMA = {
  /** 模型の隅の案内（押せることを伝える） */
  hint: "部品を押すと、中の仕事が開きます",
  /** パネルの閉じるボタン */
  close: "閉じる",
  /** 模型の部品の一覧の名前（押せるボタンの群れの aria-label） */
  partsLabel: "模型の部品",
  parts: {
    base: {
      name: "土台",
      body: "すべての仕組みが載っている台です。クラウド（AWS）と、手元のサーバーの両方で動かしています。",
      productNote: "AWS・オンプレミス",
      link: {
        label: "環境構築について見る",
        href: "/services/environment-setup",
      },
    },
    shelf: {
      name: "記事の棚",
      body: "公開する記事と、その元になるキーワードや企画をしまっておく棚です。記事の下書きは AI エージェントが書き、公開するかどうかは人が決めます。",
      productNote: "Strapi（CMS）",
      link: { label: "ブログを見る", href: "/blog" },
    },
    desk: {
      name: "問い合わせ窓口",
      body: "サイトのチャットとお問い合わせのフォームから、訪問者を迎える受付です。",
      productNote: "Chatwoot（チャット）",
      link: { label: "お問い合わせ", href: "/contact" },
    },
    roster: {
      name: "名簿",
      body: "お問い合わせをいただいた方を記録し、関心の度合いに合わせて、次のご案内の時期を整えます。",
      productNote: "Mautic（MA）",
      link: null,
    },
    pipe: {
      name: "配管",
      body: "名簿・窓口・記事の棚のあいだで、情報を決まった手順で受け渡します。同じ内容を二度書かずに済みます。",
      productNote: "n8n（ワークフロー）",
      link: null,
    },
    gauge: {
      name: "計器",
      body: "検索順位、流入、表示速度などを、毎日決まった範囲で測っています。",
      productNote: "Google アナリティクス・PostHog・Google Search Console",
      link: null,
    },
    agents: {
      name: "エージェントの詰所",
      body: "AI エージェントが計器の数字を読み、根拠のデータと元に戻す手順を添えて、改善案を下書きします。",
      productNote:
        "AI エージェント（12 の役割）と、その実行を見守る監視の仕組み",
      link: null,
    },
    approval: {
      name: "承認台",
      body: "改善案を採用するかどうか、記事を公開するかどうか、配信するかどうかは、ここで人が決めます。この判断は自動化しません。",
      productNote: "GitHub のレビュー・Strapi の公開・配信の承認・n8n の有効化",
      link: { label: "会社概要を見る", href: "/about" },
    },
    shipping: {
      name: "配信の口",
      body: "承認された変更だけが、ここからサイトに届きます。承認の無い変更は通りません。",
      productNote: "Amazon S3・CloudFront",
      link: null,
    },
    site: {
      name: "このサイト",
      body: "いまご覧のこのサイトも、この模型の仕組みで更新しています。承認された改善が届くと、画面が書き換わります。",
      productNote: "Astro（サイト）",
      link: null,
    },
    workshop: {
      name: "工房",
      body: "お客さまの業務に合わせて、仕組みを作り込む場所です。",
      productNote: null,
      link: { label: "受託開発について見る", href: "/services/development" },
    },
    drafting: {
      name: "設計の机",
      body: "DX の進め方を、お客さまと一緒に図面に描く場所です。",
      productNote: null,
      link: { label: "コンサルについて見る", href: "/services/consulting" },
    },
    bridge: {
      name: "渡り廊下",
      body: "福祉・介護・教育の事業者のみなさまと、業務提携でつながる通路です。",
      productNote: null,
      link: { label: "業務提携について見る", href: "/services/partnership" },
    },
    priceTag: {
      name: "値札",
      body: "IT 人材を 1 人雇うより低い予算で、この仕組みをお使いいただけます。",
      productNote: null,
      link: { label: "料金を見る", href: "/pricing" },
    },
  } satisfies Record<PartId, DioramaPartCopy>,
  /** 問い合わせ窓口のパネルに足す「この窓口から始まった仕事」（実績は site-content/cases.ts。掲載許可が取れたものだけ） */
  cases: {
    heading: "この窓口から始まった仕事",
    /** 3 件とも受託開発の実績。基盤を使っている会社と読まれないようにする（spec §6.3） */
    caseNote: "いずれも、ご相談から ComeGin がお作りしたものです。",
    /** 掲載許可が 1 件も無いとき */
    empty:
      "掲載の許可をいただいたものから、ここでご紹介します。現在は準備中です。",
    /** 許可が無い間に見せる、自社の事実 */
    selfNote: "ComeGin はこの模型と同じ仕組みで、自社のサイトを回しています。",
  },
} as const;
