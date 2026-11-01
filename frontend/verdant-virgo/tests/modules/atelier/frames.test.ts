import { describe, expect, it } from "vitest";
import {
  FRAME_SLOTS,
  PROPS,
  SELF_FRAMES,
  wallFrames,
} from "@/modules/atelier/client";
import type { CaseStudy } from "@/modules/site-content/cases";

// 実績の展示の壁（spec §8）。額の枠は最大数（自社 4 ＋ 3 社）を先に置き、空きは無地の額（null）。
// 他社の額は掲載許可が granted の件だけ。移り先はトップの 1-8 導入事例の節。

const kase = (
  id: CaseStudy["id"],
  permission: CaseStudy["permission"] = "granted",
): CaseStudy => ({ id, company: id, summary: "", url: null, permission });

describe("wallFrames", () => {
  describe("正常系", () => {
    it("許可の無い 3 社では、自社の額 4 つと null 3 つ（長さ 7）", () => {
      const out = wallFrames([
        kase("keizu", "pending"),
        kase("egnity", "pending"),
        kase("sho-rise", "pending"),
      ]);
      expect(FRAME_SLOTS).toBe(7);
      expect(out).toHaveLength(7);
      expect(out.slice(0, 4)).toEqual(SELF_FRAMES);
      expect(out.slice(4)).toEqual([null, null, null]);
    });

    it("移り先を持つ自社の額は jis（/accessibility/・still accessibility）だけ。experience・lighthouse・agents は href も still も null", () => {
      const byId = Object.fromEntries(SELF_FRAMES.map((f) => [f.id, f]));
      expect(byId.jis).toMatchObject({
        kind: "self",
        href: "/accessibility/",
        still: "accessibility",
      });
      for (const id of ["experience", "lighthouse", "agents"]) {
        expect(byId[id]).toMatchObject({
          kind: "self",
          href: null,
          still: null,
        });
      }
    });

    it("granted の会社が 1 件あると、その額（kind case・href '/#top-cases'。トップの 1-8 の見出しの id・still null）が自社の額の後に入り、null が 1 つ減る", () => {
      const out = wallFrames([kase("keizu", "pending"), kase("egnity")]);
      expect(out[4]).toEqual({
        id: "case:egnity",
        kind: "case",
        href: "/#top-cases",
        still: null,
      });
      expect(out.filter((f) => f === null)).toHaveLength(2);
    });

    it("額の href は、置き物の href と重ならない", () => {
      const propHrefs = new Set(
        Object.values(PROPS)
          .map((p) => p.href)
          .filter(Boolean),
      );
      for (const f of wallFrames([kase("keizu")])) {
        if (f?.href) expect(propHrefs.has(f.href)).toBe(false);
      }
    });
  });

  describe("異常系", () => {
    it("入力: 許可済みが枠を超えたら、超えた分は入れず元の順を保つ", () => {
      const many = [
        kase("sho-rise"),
        kase("keizu"),
        kase("egnity"),
        kase("keizu"),
      ];
      const out = wallFrames(many);
      expect(out).toHaveLength(7);
      expect(out.slice(4).map((f) => f?.id)).toEqual([
        "case:sho-rise",
        "case:keizu",
        "case:egnity",
      ]);
    });

    it("空入力: cases が空でも長さ 7", () => {
      expect(wallFrames([])).toHaveLength(7);
    });
  });
});
