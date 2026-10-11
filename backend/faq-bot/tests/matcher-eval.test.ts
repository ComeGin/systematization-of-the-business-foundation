import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// 実際のサイトの FAQ（正本は Astro の site-content）。faq-export は相対パスで site-content を読むので、別名の設定は要らない
import { buildFaqExport } from "../../../frontend/verdant-virgo/src/modules/faq-export/index.ts";
import { DEFAULT_THRESHOLDS } from "../src/constants.js";
import { decide } from "../src/dialog/decide.js";
import { FaqDocumentSchema } from "../src/faq/schema.js";
import { buildSnapshot } from "../src/faq/store.js";

interface Case {
  query: string;
  expect: string[];
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/paraphrases.json", import.meta.url), "utf8")) as { inFaq: Case[]; outOfFaq: string[] };

// faq-export の出力が faq-bot の契約を満たすことも、ここで確かめる（I-33）
const doc = FaqDocumentSchema.parse(buildFaqExport("https://comegin.com", new Date(0)));
const snapshot = buildSnapshot(doc.items, 0);
const ask = (text: string) => decide({ kind: "question", accountId: 1, conversationId: 1, messageId: 1, text }, snapshot, DEFAULT_THRESHOLDS);

describe("照合の評価（仕様 11 節）", () => {
  describe("正常系", () => {
    it("faq-export の出力は faq.json の契約を満たし、例文の正解の id がすべてある", () => {
      for (const c of fixture.inFaq) for (const id of c.expect) expect(snapshot.byId.has(id), `${c.query} → ${id}`).toBe(true);
    });

    it("FAQ にある質問の 80% 以上で、正しい FAQ を答えるか候補に出す", () => {
      const results = fixture.inFaq.map((c) => {
        const action = ask(c.query);
        const ok = (action.decision === "answer" || action.decision === "candidates") && action.faqIds.some((id) => c.expect.includes(id));
        return { query: c.query, expect: c.expect, decision: action.decision, faqIds: action.faqIds, top: action.topScore, ok };
      });
      const misses = results.filter((r) => !r.ok);
      const rate = (results.length - misses.length) / results.length;
      expect(rate, `正答率 ${(rate * 100).toFixed(1)}%。外れ:\n${JSON.stringify(misses, null, 1)}`).toBeGreaterThanOrEqual(0.8);
    });

    it("FAQ にある質問に、別の答えを直接返さない", () => {
      const wrong = fixture.inFaq
        .map((c) => ({ c, action: ask(c.query) }))
        .filter(({ c, action }) => action.decision === "answer" && !c.expect.includes(action.faqIds[0] ?? ""))
        .map(({ c, action }) => ({ query: c.query, answered: action.faqIds[0], top: action.topScore }));
      expect(wrong).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: FAQ に無い質問に答えない（候補か引き継ぎにする）", () => {
      const answered = fixture.outOfFaq
        .map((query) => ({ query, action: ask(query) }))
        .filter(({ action }) => action.decision === "answer")
        .map(({ query, action }) => ({ query, answered: action.faqIds[0], top: action.topScore }));
      expect(answered).toEqual([]);
    });

    it("空入力: 空の質問は引き継ぐ", () => {
      expect(ask("").decision).toBe("unmatched");
    });
  });
});
