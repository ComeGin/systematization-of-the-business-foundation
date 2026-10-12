import { describe, expect, it } from "vitest";
import { buildFaqExport, exportItems, faqPages } from "@/modules/faq-export";

const SITE = "https://comegin.com";

describe("faqPages", () => {
  describe("正常系", () => {
    it("トップ・料金・4 サービスの 6 ページを、この順で返す", () => {
      expect(faqPages().map((p) => p.key)).toEqual([
        "top",
        "pricing",
        "services-environment-setup",
        "services-development",
        "services-consulting",
        "services-partnership",
      ]);
    });

    it("context はトップが null、料金が「料金」、サービスはカードの名前", () => {
      expect(faqPages().map((p) => p.context)).toEqual([
        null,
        "料金",
        "環境構築",
        "受託開発",
        "コンサル",
        "業務提携",
      ]);
    });
  });
});

describe("buildFaqExport", () => {
  describe("正常系", () => {
    it("version 1 と、渡した時刻の generated_at", () => {
      const doc = buildFaqExport(SITE, new Date("2026-10-11T00:00:00.000Z"));
      expect(doc.version).toBe(1);
      expect(doc.generated_at).toBe("2026-10-11T00:00:00.000Z");
    });

    it("marker のある項目（【要記入】【要確認】）を出さない", () => {
      const all = faqPages().flatMap((p) => p.items);
      const marked = all.filter((item) => item.marker).length;
      const items = buildFaqExport(SITE).items;
      expect(marked).toBeGreaterThan(0);
      expect(items).toHaveLength(all.length - marked);
      expect(items.some((item) => /【要(記入|確認)】/.test(item.answer))).toBe(
        false,
      );
    });

    it("id は「ページ-元の順番」で、除いた項目も数える（id が動かない）", () => {
      const pricing = faqPages().find((p) => p.key === "pricing")!;
      const markedIndex = pricing.items.findIndex((item) => item.marker);
      const ids = buildFaqExport(SITE).items.map((item) => item.id);
      expect(ids).not.toContain(`pricing-${markedIndex + 1}`);
      expect(ids).toContain(`pricing-${markedIndex + 2}`);
    });

    it("id は重複しない", () => {
      const ids = buildFaqExport(SITE).items.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("url はページのパスと FAQ の見出しのアンカー、context はページの名前", () => {
      const items = buildFaqExport(SITE).items;
      expect(items.find((item) => item.id === "top-1")).toMatchObject({
        url: "https://comegin.com/#top-faq",
        context: null,
      });
      expect(items.find((item) => item.id === "pricing-1")).toMatchObject({
        url: "https://comegin.com/pricing#pricing-faq",
        context: "料金",
      });
      expect(
        items.find((item) => item.id === "services-consulting-2"),
      ).toMatchObject({
        url: "https://comegin.com/services/consulting#detail-faq",
        context: "コンサル",
      });
    });

    it("サイトの URL の末尾の / の有無で url が変わらない", () => {
      expect(buildFaqExport("https://comegin.com/").items[0]?.url).toBe(
        buildFaqExport(SITE).items[0]?.url,
      );
    });
  });

  describe("異常系", () => {
    it("入力: URL として読めないサイトの URL は例外", () => {
      expect(() => buildFaqExport("not a url")).toThrow(TypeError);
    });
  });
});

describe("exportItems", () => {
  const page = { key: "x", path: "/x", anchor: "x-faq", context: null };

  describe("正常系", () => {
    it("空入力: 項目の無いページは空", () => {
      expect(exportItems({ ...page, items: [] }, SITE)).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: marker が無くても、回答に【要確認】が残っていれば出さない", () => {
      expect(
        exportItems(
          { ...page, items: [{ question: "Q", answer: "A は【要確認】" }] },
          SITE,
        ),
      ).toEqual([]);
    });
  });
});
