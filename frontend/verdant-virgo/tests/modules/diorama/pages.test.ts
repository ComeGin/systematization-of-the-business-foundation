import { describe, expect, it } from "vitest";
import { PAGE_VIEWS, type PageKey } from "@/modules/diorama/client";

// ページごとの見せ方（spec §5.1 の右の列・§6.7・H-9）。A＝動く（トップだけ触れる）、B＝静止画。
// PAGE_VIEWS は定数で、関数の入力が無いので「空入力: 」「入力: 」のケースは置かない。

const keys = Object.keys(PAGE_VIEWS) as PageKey[];

describe("PAGE_VIEWS", () => {
  describe("正常系", () => {
    it("11 のページすべてに見せ方がある", () => {
      expect(keys.sort()).toEqual(
        [
          "about",
          "blog",
          "contact",
          "contactThanks",
          "pricing",
          "service:consulting",
          "service:development",
          "service:environment-setup",
          "service:partnership",
          "services",
          "top",
        ].sort(),
      );
    });

    it("top だけが live-touch、services とサービス詳細 4 本は live-view、B の 5 本は still", () => {
      expect(PAGE_VIEWS.top.mode).toBe("live-touch");
      for (const key of [
        "services",
        "service:environment-setup",
        "service:development",
        "service:consulting",
        "service:partnership",
      ] as const)
        expect(PAGE_VIEWS[key].mode).toBe("live-view");
      for (const key of [
        "about",
        "pricing",
        "blog",
        "contact",
        "contactThanks",
      ] as const)
        expect(PAGE_VIEWS[key].mode).toBe("still");
    });

    it("focus は spec の表どおり", () => {
      expect(
        Object.fromEntries(keys.map((k) => [k, PAGE_VIEWS[k].focus])),
      ).toEqual({
        top: null,
        services: null,
        "service:environment-setup": "base",
        "service:development": "workshop",
        "service:consulting": "drafting",
        "service:partnership": "bridge",
        about: "approval",
        blog: "shelf",
        contact: "desk",
        contactThanks: "desk",
        pricing: "priceTag",
      });
    });

    it("カメラ名は cam_ ＋ PageKey（: は _）", () => {
      for (const key of keys)
        expect(PAGE_VIEWS[key].camera).toBe(`cam_${key.replace(":", "_")}`);
    });

    it("トップと会社概要は、模型の中のアバターが写る", () => {
      expect(PAGE_VIEWS.top.showsAvatar).toBe(true);
      expect(PAGE_VIEWS.about.showsAvatar).toBe(true);
    });
  });
});
