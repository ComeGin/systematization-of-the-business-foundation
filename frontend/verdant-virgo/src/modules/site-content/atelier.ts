// ヒーロー第 2 版「デザイナーのアトリエ」の文言（atelier モジュールの AtelierHero・AtelierTouch・AtelierTips・AtelierList が読む）。
// 設計は docs/superpowers/specs/2026-10-28-hero-atelier-design.md §6.3・§6.4・§8。部品は文言の既定値を持たない（H-16）。
// 2026-10-29 14:41 にユーザーが承認した文言（計画 Task 4 の Step 0）。Tips は見出し 20 字・説明 60 字まで。
// 言い回しは services.ts・pricing.ts・about.ts の文にそろえる。架空の社名・数値を入れない（GL §8.4）。
// lighthouse の額の値は、2026-10-29 13:57 に pnpm lh で測った値（トップ。5 回の中央値）。計り直して変わったら直す。
import type { PropId } from "@/modules/atelier/client";

export interface AtelierTipCopy {
  heading: string;
  body: string;
  /** Tips のリンクの文字 */
  cta: string;
}

export interface AtelierFrameCopy {
  title: string;
  body: string;
  /** 移り先を持つ額だけ（spec §8。jis） */
  cta?: string;
}

export const ATELIER: {
  hint: string;
  forward: string;
  back: string;
  close: string;
  avatarName: string;
  listHeading: string;
  props: Record<Exclude<PropId, "avatar" | "wall">, AtelierTipCopy>;
  frames: Record<
    "experience" | "jis" | "lighthouse" | "agents",
    AtelierFrameCopy
  >;
  caseCta: string;
} = {
  hint: "空いている所にカーソルを置くと前へ進みます（スマートフォンは長押し）",
  forward: "前へ進む",
  back: "入口に戻る",
  close: "閉じる",
  avatarName: "代表 亀谷 銀大",
  listHeading: "アトリエの案内",
  props: {
    nameplate: {
      heading: "ComeGin について",
      body: "代表 1名の個人事業です。現場から始め、一次資料で語ることを大切にしています。",
      cta: "見る",
    },
    envSetup: {
      heading: "環境構築",
      body: "事業経営基盤の一式を、お客さまのクラウドか端末に構築します。ソースコードは無料です。",
      cta: "見る",
    },
    development: {
      heading: "受託開発",
      body: "7日間で動くものを作るプランと、要件定義から運用保守までを担うプランがあります。",
      cta: "見る",
    },
    consulting: {
      heading: "コンサル",
      body: "DX の推進を、小さく作って確かめながら進める伴走です。4回からお申し込みいただけます。",
      cta: "見る",
    },
    partnership: {
      heading: "業務提携",
      body: "福祉・介護・教育の事業を行う中小企業・社会福祉法人・非営利団体の皆さまと提携します。",
      cta: "見る",
    },
    pricing: {
      heading: "料金",
      body: "サービスごとの料金と、お申し込みからご契約までの流れをまとめています。",
      cta: "見る",
    },
    blog: {
      heading: "ブログ",
      body: "仕組みづくりの考え方と、このサイトを動かしている基盤のことを書いています。",
      cta: "見る",
    },
    contact: {
      heading: "無料相談",
      body: "いまの状況をお聞かせください。どこから仕組みにするかを一緒に考えます。",
      cta: "見る",
    },
  },
  frames: {
    experience: {
      title: "この体験そのもの",
      body: "Astro・React・Three.js で、いま歩いているアトリエを作りました。",
    },
    jis: {
      title: "JIS X 8341-3 に一部準拠",
      body: "AA を目標に試験し、結果を公開しています。",
      cta: "試験結果を見る",
    },
    lighthouse: {
      // 2026-10-29 にユーザーが改めた（案 A）。題だけを読んでも、100 点が SEO とアクセシビリティの値と分かるように（performance は 100 ではない）
      title: "SEO・アクセシビリティ 100 点",
      body: "Lighthouse でトップページを計測（2026-10-29）。",
    },
    agents: {
      title: "運用を回すエージェント",
      body: "12 の役割の AI エージェントが観測と提案を担い、採否は人が決めます。",
    },
  },
  caseCta: "導入事例を見る",
};
