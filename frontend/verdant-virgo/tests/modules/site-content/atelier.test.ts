import { describe, expect, it } from "vitest";
import { ATELIER } from "@/modules/site-content/atelier";
import { PROPS } from "@/modules/atelier/client";

// アトリエの文言（2026-10-29 にユーザーが承認。spec §6.3・§8）。Tips は見出し 20 字・説明 60 字まで。仮の印を残さない。

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(strings)
      : [];

describe("ATELIER", () => {
  describe("正常系", () => {
    it("置き物 8 つ・自社の額 4 枚の文言がある", () => {
      const withHref = Object.values(PROPS)
        .filter((p) => p.href)
        .map((p) => p.id)
        .sort();
      expect(Object.keys(ATELIER.props).sort()).toEqual(withHref);
      expect(withHref).toHaveLength(8);
      expect(Object.keys(ATELIER.frames).sort()).toEqual([
        "agents",
        "experience",
        "jis",
        "lighthouse",
      ]);
    });

    it("Tips の見出しは 20 字・説明は 60 字以内", () => {
      for (const tip of Object.values(ATELIER.props)) {
        expect([...tip.heading].length, tip.heading).toBeLessThanOrEqual(20);
        expect([...tip.body].length, tip.body).toBeLessThanOrEqual(60);
      }
    });

    it("【要記入】などの仮の印を含まない", () => {
      for (const s of strings(ATELIER))
        expect(s).not.toMatch(/【|要記入|TODO|TBD|仮|サンプル|XXX/);
    });

    it("移り先を持つ額（jis）だけが cta を持つ", () => {
      expect(ATELIER.frames.jis.cta).toBeTruthy();
      for (const id of ["experience", "lighthouse", "agents"] as const)
        expect(ATELIER.frames[id].cta).toBeUndefined();
    });
  });

  describe("異常系", () => {
    it("空入力: 空の文字列が無い", () => {
      for (const s of strings(ATELIER))
        expect(s.trim().length).toBeGreaterThan(0);
    });
  });
});
