import { describe, expect, it } from "vitest";
import {
  glowFromPointer,
  tiltFromPointer,
} from "@/modules/motion/lib/pointer-vars";

describe("tiltFromPointer", () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };

  describe("正常系", () => {
    it("中心は 0", () =>
      expect(tiltFromPointer(rect, 100, 50, 8)).toEqual({
        rotateX: 0,
        rotateY: 0,
      }));
    it("右上の角は rotateY=+8・rotateX=+8", () =>
      expect(tiltFromPointer(rect, 200, 0, 8)).toEqual({
        rotateX: 8,
        rotateY: 8,
      }));
    it("左下の角は rotateY=-8・rotateX=-8", () =>
      expect(tiltFromPointer(rect, 0, 100, 8)).toEqual({
        rotateX: -8,
        rotateY: -8,
      }));
    it("右端と中心の中間は半分", () =>
      expect(tiltFromPointer(rect, 150, 50, 8)).toEqual({
        rotateX: 0,
        rotateY: 4,
      }));
    it("rect が画面の途中にあっても位置は rect の左上からの相対", () =>
      expect(
        tiltFromPointer({ left: 300, top: 400, width: 200, height: 100 }, 400, 450, 8),
      ).toEqual({ rotateX: 0, rotateY: 0 }));
  });

  describe("異常系", () => {
    it("入力: 範囲の外は端に丸める", () =>
      expect(tiltFromPointer(rect, 999, -50, 8)).toEqual({
        rotateX: 8,
        rotateY: 8,
      }));
    it("空入力: 幅か高さが 0 なら 0", () =>
      expect(tiltFromPointer({ ...rect, width: 0 }, 10, 10, 8)).toEqual({
        rotateX: 0,
        rotateY: 0,
      }));
    it("入力: 高さが 0 でも 0", () =>
      expect(tiltFromPointer({ ...rect, height: 0 }, 10, 10, 8)).toEqual({
        rotateX: 0,
        rotateY: 0,
      }));
    it("入力: maxDeg が 0 なら傾けない", () =>
      expect(tiltFromPointer(rect, 200, 0, 0)).toEqual({
        rotateX: 0,
        rotateY: 0,
      }));
    it("入力: NaN の座標は 0", () =>
      expect(tiltFromPointer(rect, Number.NaN, Number.NaN, 8)).toEqual({
        rotateX: 0,
        rotateY: 0,
      }));
  });
});

describe("glowFromPointer", () => {
  describe("正常系", () => {
    it("左上の 1/4 は 25%・25%", () =>
      expect(
        glowFromPointer({ left: 0, top: 0, width: 200, height: 100 }, 50, 25),
      ).toEqual({ x: "25%", y: "25%" }));
    it("小数は 1 桁まで（37.5%）", () =>
      expect(
        glowFromPointer({ left: 0, top: 0, width: 200, height: 100 }, 75, 37.5),
      ).toEqual({ x: "37.5%", y: "37.5%" }));
  });

  describe("異常系", () => {
    it("空入力: 幅か高さが 0 なら 50%", () =>
      expect(
        glowFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 1, 1),
      ).toEqual({ x: "50%", y: "50%" }));
    it("入力: 範囲の外は 0%〜100% に丸める", () =>
      expect(
        glowFromPointer({ left: 0, top: 0, width: 200, height: 100 }, -40, 500),
      ).toEqual({ x: "0%", y: "100%" }));
  });
});
