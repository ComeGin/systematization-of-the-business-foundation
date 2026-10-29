// 実績（他社の仕事）のデータ。ヒーローのアトリエの展示の壁（lib/frames.ts の wallFrames）と、トップの 1-8 導入事例の両方が読む（二重に管理しない）。
// 設計は第 1 版のヒーローの spec（docs/superpowers/specs/2026-10-28-hero-*-design.md）§7。第 2 版（アトリエ）でも同じ定義を使う。社名・内容・URL は 2026-10-28 のユーザーの入力どおり（H-7）。
// 掲載許可が取れたら permission を 'granted' にする。'granted' の件だけが画面に出る（publishedCases）。
// 許可の範囲（ロゴ・お客さまの声・数値）が分かるまで、項目は会社名・内容・URL だけ。架空の社名・数値を足さない（GL §8.4）。
// 3 件とも受託開発の実績で、「基盤を使っている会社」ではない。見せる側の文言でそう読まれないようにする（spec §6.3）。

export interface CaseStudy {
  id: "keizu" | "egnity" | "sho-rise";
  company: string;
  summary: string;
  /** 会社のサイト。無ければ null */
  url: string | null;
  permission: "granted" | "pending";
}

export const CASES: readonly CaseStudy[] = [
  {
    id: "keizu",
    company: "合同会社ケイズ",
    summary: "就労継続支援B型事業所内で使用する、出品支援アプリの開発",
    url: "https://keizub.com/",
    permission: "pending",
  },
  {
    id: "egnity",
    company: "株式会社エグニティー",
    summary: "物販事業で使用する、リサーチ支援アプリの開発",
    url: null,
    permission: "pending",
  },
  {
    id: "sho-rise",
    company: "SHO-RISE Drift Simulator Studio",
    summary: "ドリフトシミュレータ内で使用する、オリジナルコースMODの作成",
    url: null,
    permission: "pending",
  },
];

/** 掲載許可が取れた件だけを、元の順のまま返す */
export function publishedCases(
  cases: readonly CaseStudy[] = CASES,
): readonly CaseStudy[] {
  return cases.filter((c) => c.permission === "granted");
}
