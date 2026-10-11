import { describe, expect, it } from "vitest";
import { MESSAGES } from "../../src/constants.js";
import { welcomeItems, welcomeReply } from "../../src/dialog/welcome.js";
import { makeFaqItem } from "../helpers/faq.js";

const item = (id: string, question = `質問 ${id}`, context: string | null = null) => makeFaqItem({ id, question, context });

describe("welcomeItems", () => {
  describe("正常系", () => {
    it("トップページの項目（top-）だけを faq.json の順にとる", () => {
      const items = [item("top-1"), item("pricing-1", "料金", "料金"), item("top-3"), item("services-consulting-2")];
      expect(welcomeItems({ items }).map((i) => i.id)).toEqual(["top-1", "top-3"]);
    });

    it("最大 6 件", () => {
      const items = Array.from({ length: 8 }, (_, n) => item(`top-${n + 1}`));
      expect(welcomeItems({ items }).map((i) => i.id)).toEqual(["top-1", "top-2", "top-3", "top-4", "top-5", "top-6"]);
    });

    it("空入力: トップページの項目が無ければ空", () => {
      expect(welcomeItems({ items: [item("pricing-1")] })).toEqual([]);
      expect(welcomeItems({ items: [] })).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: top で始まっても、ページの key が違う id（topics-1 など）は出さない", () => {
      expect(welcomeItems({ items: [item("topics-1"), item("top-2")] }).map((i) => i.id)).toEqual(["top-2"]);
    });

    // 2026-10-12 の最終レビュー（Minor）: ページの key にはハイフンが入る（services-<slug>）ので、将来 top- で始まる key のページを足すと混ざる
    it("入力: top- の後が数字だけでない id（top-campaign-1 など、top- で始まる別のページの key）は出さない", () => {
      expect(welcomeItems({ items: [item("top-campaign-1"), item("top-1"), item("top-"), item("top-1a")] }).map((i) => i.id)).toEqual(["top-1"]);
    });
  });
});

describe("welcomeReply", () => {
  describe("正常系", () => {
    it("本文と、質問（context があれば括弧つき）の見出し・FAQ の id の値の選択肢", () => {
      expect(welcomeReply([item("top-3", "料金は税込ですか？"), item("top-9", "契約の期間", "コンサル")])).toEqual({
        kind: "select",
        content: MESSAGES.welcome,
        items: [
          { title: "料金は税込ですか？", value: "top-3" },
          { title: "契約の期間（コンサル）", value: "top-9" },
        ],
      });
    });
  });
});
