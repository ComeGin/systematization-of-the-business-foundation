import { describe, expect, it } from "vitest";
import {
  dioramaZoomOrigin,
  pageKeyForPath,
  type PartId,
} from "@/modules/diorama/client";

// ページの移動を「模型に寄るカメラ」に見せる（spec §9 の 3。計画 Task 10）。
// 移動元のページの模型が、行き先のページの焦点の部品（PAGE_VIEWS の focus）の位置を中心に拡大しながら消える。
// 拡大の中心は、移動元の画面での部品の位置（模型の枠に対する %）。

const anchors = new Map<PartId, { x: number; y: number }>([
  ["workshop", { x: 320, y: 90 }],
  ["approval", { x: 600, y: 200 }],
]);
const size = { width: 800, height: 450 };

describe("pageKeyForPath", () => {
  describe("正常系", () => {
    it("模型のあるページのパスを PageKey に直す（末尾の / の有無を問わない）", () => {
      expect(pageKeyForPath("/")).toBe("top");
      expect(pageKeyForPath("/services/")).toBe("services");
      expect(pageKeyForPath("/services/development/")).toBe(
        "service:development",
      );
      expect(pageKeyForPath("/services/partnership")).toBe(
        "service:partnership",
      );
      expect(pageKeyForPath("/about/")).toBe("about");
      expect(pageKeyForPath("/contact/thanks/")).toBe("contactThanks");
    });
  });

  describe("異常系", () => {
    it("入力: 模型の無いページ・知らないサービスは null", () => {
      expect(pageKeyForPath("/legal/privacy/")).toBeNull();
      expect(pageKeyForPath("/services/unknown/")).toBeNull();
    });
  });

  it("空入力: 空の文字列は null", () => {
    expect(pageKeyForPath("")).toBeNull();
  });
});

describe("dioramaZoomOrigin", () => {
  describe("正常系", () => {
    it("top → service:development は、移動元での workshop の位置の %", () => {
      expect(
        dioramaZoomOrigin("top", "service:development", anchors, size),
      ).toEqual({ x: "40%", y: "20%" });
    });

    it("services → top は null（全景へ戻るときは寄らない）", () => {
      expect(dioramaZoomOrigin("services", "top", anchors, size)).toBeNull();
    });

    it("行き先が B（静止画）のページは null（動く模型どうしの移動だけ）", () => {
      expect(dioramaZoomOrigin("top", "about", anchors, size)).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: 範囲外の座標は 0〜100% に丸める", () => {
      const far = new Map<PartId, { x: number; y: number }>([
        ["workshop", { x: -50, y: 900 }],
      ]);
      expect(
        dioramaZoomOrigin("top", "service:development", far, size),
      ).toEqual({ x: "0%", y: "100%" });
    });
  });

  it("空入力: anchors が空なら null", () => {
    expect(
      dioramaZoomOrigin("top", "service:development", new Map(), size),
    ).toBeNull();
  });
});
