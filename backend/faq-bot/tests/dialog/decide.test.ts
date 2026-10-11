import { describe, expect, it } from "vitest";
import type { QuestionEvent, SelectionEvent } from "../../src/chatwoot/events.js";
import { candidateTitle, decide, sameAnswer } from "../../src/dialog/decide.js";
import { buildSnapshot } from "../../src/faq/store.js";
import { makeFaqItem } from "../helpers/faq.js";

const ITEMS = [
  makeFaqItem({ id: "top-3", question: "料金は税込ですか？", answer: "表示価格はすべて税別です。", url: "https://comegin.com/#top-faq" }),
  makeFaqItem({ id: "pricing-1", question: "表示価格は税込ですか？", answer: "いいえ。表示価格はすべて税別です。", url: "https://comegin.com/pricing#pricing-faq", context: "料金" }),
  makeFaqItem({ id: "services-consulting-2", question: "契約の期間と解約を教えてください", answer: "コンサルティング契約書と発注書を取り交わします。契約期間は 1か月です。", url: "https://comegin.com/services/consulting#detail-faq", context: "コンサル" }),
  makeFaqItem({ id: "services-partnership-4", question: "契約の期間と解約を教えてください", answer: "業務提携契約書と発注書を取り交わします。契約期間は 1年です。", url: "https://comegin.com/services/partnership#detail-faq", context: "業務提携" }),
  makeFaqItem({ id: "pricing-2", question: "お支払いの方法と時期を教えてください", answer: "クレジットカードまたは銀行振込でお願いしています。", url: "https://comegin.com/pricing#pricing-faq", context: "料金" }),
];
const SNAPSHOT = buildSnapshot(ITEMS, 0);
const T = { high: 0.5, low: 0.25, margin: 0.1 };
const target = { accountId: 1, conversationId: 12, messageId: 101 };
const ask = (text: string): QuestionEvent => ({ kind: "question", ...target, text });
const pick = (value: string): SelectionEvent => ({ kind: "selection", ...target, messageId: 205, value });

describe("decide（質問）", () => {
  describe("正常系", () => {
    it("近い FAQ がはっきり 1 位なら、原文とページの URL で答え、faq-answered を足す", () => {
      expect(decide(ask("料金は税込ですか？"), SNAPSHOT, T)).toEqual({
        decision: "answer",
        reply: {
          kind: "select",
          content: "表示価格はすべて税別です。\n\n詳しくは: https://comegin.com/#top-faq",
          items: [
            { title: "解決しました", value: "__resolved" },
            { title: "担当者に相談する", value: "__handoff" },
          ],
        },
        addLabels: ["faq-answered"],
        status: null,
        faqIds: ["top-3"],
        topScore: 1,
      });
    });

    it("2 位が答えの同じ重複なら、差のしきい値の判定で飛ばす", () => {
      // top-3 と pricing-1 は答えが実質同じ（一方が他方を含む）
      expect(decide(ask("表示価格は税込ですか"), SNAPSHOT, T).decision).toBe("answer");
    });

    it("答えの違う同じ質問が並んだら、context つきの候補を出す", () => {
      const action = decide(ask("契約の期間と解約を教えてください"), SNAPSHOT, T);
      expect(action.decision).toBe("candidates");
      expect(action.reply).toEqual({
        kind: "select",
        content: "次のどれに近いですか？",
        items: [
          { title: "契約の期間と解約を教えてください（コンサル）", value: "services-consulting-2" },
          { title: "契約の期間と解約を教えてください（業務提携）", value: "services-partnership-4" },
          { title: "どれにも当てはまらない", value: "__none" },
        ],
      });
      expect(action).toMatchObject({ addLabels: [], status: null, faqIds: ["services-consulting-2", "services-partnership-4"] });
    });

    it("context を含む質問は、そのページの FAQ に寄る", () => {
      const action = decide(ask("コンサルの契約の期間と解約は？"), SNAPSHOT, T);
      expect(action.faqIds[0]).toBe("services-consulting-2");
    });

    it("下と上のしきい値の間なら候補を出し、答えの同じ候補は 1 つにまとめる", () => {
      const action = decide(ask("税込？"), SNAPSHOT, T);
      expect(action.decision).toBe("candidates");
      expect(action.faqIds).toEqual(["top-3"]);
    });

    it("しきい値を下げれば同じ質問に答える", () => {
      expect(decide(ask("税込？"), SNAPSHOT, { ...T, high: 0.3 }).decision).toBe("answer");
    });

    it("下のしきい値より低ければ faq-unmatched で引き継ぐ", () => {
      expect(decide(ask("営業時間は何時までですか"), SNAPSHOT, T)).toEqual({
        decision: "unmatched",
        reply: { kind: "text", content: "担当者におつなぎします。順番にお返事しますので、このままお待ちください。" },
        addLabels: ["faq-unmatched"],
        status: "open",
        faqIds: [],
        topScore: 0,
      });
    });
  });

  describe("異常系", () => {
    it("入力: 記号と絵文字だけの発言は落ちずに faq-unmatched で引き継ぐ", () => {
      expect(decide(ask("？？？👍"), SNAPSHOT, T)).toMatchObject({ decision: "unmatched", status: "open", topScore: 0 });
    });

    it("空入力: FAQ が 0 件なら faq-unmatched で引き継ぐ", () => {
      expect(decide(ask("料金は税込ですか？"), buildSnapshot([], 0), T)).toMatchObject({ decision: "unmatched", addLabels: ["faq-unmatched"] });
    });
  });
});

describe("decide（選択）", () => {
  describe("正常系", () => {
    it("FAQ の id を選んだら、その FAQ で答える", () => {
      expect(decide(pick("services-consulting-2"), SNAPSHOT, T)).toMatchObject({
        decision: "answer",
        addLabels: ["faq-answered"],
        faqIds: ["services-consulting-2"],
        topScore: null,
      });
    });

    it("［解決しました］は resolved にする", () => {
      expect(decide(pick("__resolved"), SNAPSHOT, T)).toEqual({
        decision: "resolved",
        reply: { kind: "text", content: "お役に立ててよかったです。ほかにもご質問があれば、いつでもどうぞ。" },
        addLabels: [],
        status: "resolved",
        faqIds: [],
        topScore: null,
      });
    });

    it("［担当者に相談する］は faq-handoff で引き継ぐ", () => {
      expect(decide(pick("__handoff"), SNAPSHOT, T)).toMatchObject({ decision: "handoff", addLabels: ["faq-handoff"], status: "open" });
    });

    it("［どれにも当てはまらない］は faq-unmatched で引き継ぐ", () => {
      expect(decide(pick("__none"), SNAPSHOT, T)).toMatchObject({ decision: "unmatched", addLabels: ["faq-unmatched"], status: "open" });
    });
  });

  describe("異常系", () => {
    it("入力: faq.json から消えた FAQ の id は faq-unmatched で引き継ぐ", () => {
      expect(decide(pick("top-99"), SNAPSHOT, T)).toMatchObject({ decision: "unmatched", status: "open" });
    });

    it("空入力: 空の値は faq-unmatched で引き継ぐ", () => {
      expect(decide(pick(""), SNAPSHOT, T)).toMatchObject({ decision: "unmatched" });
    });
  });
});

describe("candidateTitle", () => {
  describe("正常系", () => {
    it("context があれば括弧で付ける", () => {
      expect(candidateTitle(makeFaqItem({ question: "Q", context: "料金" }))).toBe("Q（料金）");
    });

    it("空入力: context が null なら質問だけ", () => {
      expect(candidateTitle(makeFaqItem({ question: "Q", context: null }))).toBe("Q");
    });
  });
});

describe("sameAnswer", () => {
  describe("正常系", () => {
    it("正規化した一方が他方を含めば同じ", () => {
      expect(sameAnswer(ITEMS[0]!, ITEMS[1]!)).toBe(true);
    });

    it("違う答えは違う", () => {
      expect(sameAnswer(ITEMS[2]!, ITEMS[3]!)).toBe(false);
    });
  });

  describe("異常系", () => {
    it("空入力: 記号だけの答え（正規化して空）は、ほかの答えと同じとみなさない", () => {
      expect(sameAnswer(makeFaqItem({ answer: "。" }), ITEMS[0]!)).toBe(false);
    });
  });
});
