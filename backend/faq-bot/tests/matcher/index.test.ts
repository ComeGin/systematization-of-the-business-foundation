import { describe, expect, it } from "vitest";
import { buildIndex, dice, grams, normalize, rank } from "../../src/matcher/index.js";

describe("normalize", () => {
  describe("正常系", () => {
    it("NFKC で全角・半角をそろえ、小文字にする", () => {
      expect(normalize("４時間のＡＩ")).toBe(normalize("4時間のai"));
    });

    it("空白・句読点・記号を削る", () => {
      expect(normalize("料金は、 税込？（本当に）")).toBe("料金は税込本当に");
    });

    it("末尾の定型句を繰り返し削る", () => {
      expect(normalize("料金について教えてください")).toBe("料金");
      expect(normalize("料金は税込ですか？")).toBe("料金は税込");
    });

    it("定型句だけの文は丸ごと消さない", () => {
      expect(normalize("とは")).toBe("とは");
    });

    it("空入力: 空文字は空文字のまま", () => {
      expect(normalize("")).toBe("");
    });
  });

  describe("異常系", () => {
    it("入力: 記号と絵文字だけなら空になる", () => {
      expect(normalize("？？？👍")).toBe("");
    });
  });
});

describe("grams", () => {
  describe("正常系", () => {
    it("2-gram を作る", () => {
      expect([...grams("料金表", 2)]).toEqual(["料金", "金表"]);
    });

    it("1-gram は文字の集合", () => {
      expect([...grams("料料金", 1)]).toEqual(["料", "金"]);
    });

    it("サロゲートペアを 1 文字として扱う", () => {
      expect([...grams("𠮷野", 2)]).toEqual(["𠮷野"]);
    });

    it("空入力: 空文字は空の集合", () => {
      expect(grams("", 2).size).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: 1 文字は 2-gram を作れない", () => {
      expect(grams("料", 2).size).toBe(0);
    });
  });
});

describe("dice", () => {
  describe("正常系", () => {
    it("同じ集合は 1、共通が無ければ 0", () => {
      expect(dice(new Set(["ab", "bc"]), new Set(["ab", "bc"]))).toBe(1);
      expect(dice(new Set(["ab"]), new Set(["cd"]))).toBe(0);
    });

    it("2|A∩B| / (|A|+|B|)", () => {
      expect(dice(new Set(["ab", "bc"]), new Set(["ab", "cd", "de"]))).toBeCloseTo(0.4);
    });
  });

  describe("異常系", () => {
    it("空入力: どちらかが空なら 0", () => {
      expect(dice(new Set(), new Set(["ab"]))).toBe(0);
    });
  });
});

describe("rank", () => {
  const items = [
    { id: "tax", q: "料金は税込ですか？" },
    { id: "pay", q: "お支払いの方法と時期を教えてください" },
    { id: "cloud", q: "クラウドの利用料は料金に含まれますか？" },
  ];
  const index = buildIndex(items, (item) => item.q);

  describe("正常系", () => {
    it("近い質問が 1 位になり、スコアの降順に並ぶ", () => {
      const ranked = rank("料金って税込なの？", index);
      expect(ranked[0]?.item.id).toBe("tax");
      expect(ranked.map((r) => r.score)).toEqual([...ranked.map((r) => r.score)].sort((a, b) => b - a));
    });

    it("同じ質問は 1.0", () => {
      expect(rank("料金は税込ですか？", index)[0]?.score).toBe(1);
    });

    it("全角と半角の違いでスコアが変わらない", () => {
      expect(rank("クラウドの利用料は料金に含まれますか", index)[0]?.score).toBe(rank("ｸﾗｳﾄﾞの利用料は料金に含まれますか", index)[0]?.score);
    });

    it("1 文字の質問は 1-gram で比べる（「料」と「料金は税込」の 1-gram は 2×1/(1+5)）", () => {
      const ranked = rank("料", index);
      expect(ranked[0]?.item.id).toBe("tax");
      expect(ranked[0]?.score).toBeCloseTo(2 / 6);
    });

    it("同点は索引の順", () => {
      const tie = buildIndex([{ q: "同じ" }, { q: "同じ" }], (item) => item.q);
      expect(rank("同じ", tie).map((r) => r.item)).toEqual([tie[0]?.item, tie[1]?.item]);
    });
  });

  describe("異常系", () => {
    it("空入力: 空の質問は空の結果", () => {
      expect(rank("", index)).toEqual([]);
    });

    it("入力: 記号だけの質問は空の結果", () => {
      expect(rank("？？？", index)).toEqual([]);
    });

    it("空入力: 空の索引は空の結果", () => {
      expect(rank("料金", [])).toEqual([]);
    });
  });
});
