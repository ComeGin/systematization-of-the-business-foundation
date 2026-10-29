import { describe, expect, it } from "vitest";
import {
  STILL_VIEWS,
  pageKeyForPath,
  type PageKey,
} from "@/modules/atelier/client";

// ページごとの冒頭の静止画のカメラ（spec §7）。トップは一人称のスタート地点、下層ページは同じアトリエの別の場所。

const ALL: PageKey[] = [
  "top",
  "services",
  "service:environment-setup",
  "service:development",
  "service:consulting",
  "service:partnership",
  "about",
  "pricing",
  "blog",
  "contact",
  "contactThanks",
  "accessibility",
];

describe("STILL_VIEWS", () => {
  describe("正常系", () => {
    it("12 のページすべてに STILL_VIEWS がある。camera は cam_ ＋ PageKey の : を _ に変えたもの", () => {
      expect(Object.keys(STILL_VIEWS).sort()).toEqual([...ALL].sort());
      for (const key of ALL) {
        expect(STILL_VIEWS[key].camera).toBe(`cam_${key.replace(":", "_")}`);
      }
    });

    it("mobile が true なのは top・services とサービス詳細 4 本", () => {
      const mobile = ALL.filter((k) => STILL_VIEWS[k].mobile).sort();
      expect(mobile).toEqual(
        [
          "top",
          "services",
          "service:environment-setup",
          "service:development",
          "service:consulting",
          "service:partnership",
        ].sort(),
      );
    });

    it("showsAvatar が true なのは top と about", () => {
      expect(ALL.filter((k) => STILL_VIEWS[k].showsAvatar).sort()).toEqual([
        "about",
        "top",
      ]);
    });
  });
});

describe("pageKeyForPath", () => {
  describe("正常系", () => {
    it("pageKeyForPath は末尾の / の有無を問わず 12 のページを返し、/accessibility も返す", () => {
      const paths: Record<string, PageKey> = {
        "/": "top",
        "/services/": "services",
        "/services/environment-setup/": "service:environment-setup",
        "/services/development": "service:development",
        "/services/consulting/": "service:consulting",
        "/services/partnership": "service:partnership",
        "/about/": "about",
        "/pricing": "pricing",
        "/blog/": "blog",
        "/contact/": "contact",
        "/contact/thanks/": "contactThanks",
        "/accessibility": "accessibility",
      };
      for (const [path, key] of Object.entries(paths)) {
        expect(pageKeyForPath(path)).toBe(key);
      }
      expect(pageKeyForPath("/accessibility/")).toBe("accessibility");
    });
  });

  describe("異常系", () => {
    it("入力: 知らないサービスの slug・規約のページは null", () => {
      expect(pageKeyForPath("/services/unknown/")).toBeNull();
      expect(pageKeyForPath("/terms/")).toBeNull();
      expect(pageKeyForPath("/privacy/")).toBeNull();
    });

    it("空入力: 空の文字列は null", () => {
      expect(pageKeyForPath("")).toBeNull();
    });
  });
});
