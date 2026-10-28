import { describe, expect, it } from "vitest";
import {
  CASES,
  publishedCases,
  type CaseStudy,
} from "@/modules/site-content/cases";

// 実績のデータ（spec §7・H-7）。掲載許可（permission: 'granted'）が付いた件だけを画面に出す。
// 架空の社名・人名・数値を出さない（GL §8.4）ため、許可の無い件が漏れないことを固定する。

const make = (
  id: CaseStudy["id"],
  permission: CaseStudy["permission"],
): CaseStudy => ({
  id,
  company: id,
  summary: id,
  url: null,
  permission,
});

describe("publishedCases", () => {
  describe("正常系", () => {
    it("granted だけを返す", () => {
      const cases = [
        make("keizu", "granted"),
        make("egnity", "pending"),
        make("sho-rise", "granted"),
      ];
      expect(publishedCases(cases).map((c) => c.id)).toEqual([
        "keizu",
        "sho-rise",
      ]);
    });

    it("元の順を保つ", () => {
      const cases = [make("sho-rise", "granted"), make("keizu", "granted")];
      expect(publishedCases(cases).map((c) => c.id)).toEqual([
        "sho-rise",
        "keizu",
      ]);
    });

    it("CASES の 3 件はいまはすべて pending（ユーザーの入力どおり）", () => {
      expect(CASES).toEqual([
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
          summary:
            "ドリフトシミュレータ内で使用する、オリジナルコースMODの作成",
          url: null,
          permission: "pending",
        },
      ]);
      expect(publishedCases()).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: permission が不明な値の件は返さない", () => {
      const odd = {
        ...make("keizu", "granted"),
        permission: "yes",
      } as unknown as CaseStudy;
      expect(publishedCases([odd])).toEqual([]);
    });
  });

  it("空入力: 空の配列なら空を返す", () => {
    expect(publishedCases([])).toEqual([]);
  });
});
