import { describe, expect, it } from "vitest";
import { createRail } from "@/modules/atelier/client";

// 道のレール（spec §5.1・§6.2）。glb の rail_NN の点列を折れ線にし、弧長で 0〜1 に割る。
// 止まる所は、置き物の点にいちばん近いレールの位置。

const line: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, -2],
  [0, 0, -4],
];

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));

describe("createRail", () => {
  describe("正常系", () => {
    it("at(0) は最初の点、at(1) は最後の点", () => {
      const rail = createRail(line, []);
      close(rail.at(0).position, [0, 0, 0]);
      close(rail.at(1).position, [0, 0, -4]);
      expect(rail.length).toBeCloseTo(4);
    });

    it("at は長さに比例して進む", () => {
      const rail = createRail(
        [
          [0, 0, 0],
          [0, 0, -1],
          [0, 0, -4],
        ],
        [],
      );
      close(rail.at(0.25).position, [0, 0, -1]);
      close(rail.at(0.5).position, [0, 0, -2]);
    });

    it("forward は進む向きの単位ベクトル", () => {
      const rail = createRail(
        [
          [0, 0, 0],
          [0, 0, -2],
          [2, 0, -2],
        ],
        [],
      );
      close(rail.at(0.25).forward, [0, 0, -1]);
      close(rail.at(0.75).forward, [1, 0, 0]);
      const f = rail.at(0.5).forward;
      expect(Math.hypot(...f)).toBeCloseTo(1);
    });

    it("stops は t の昇順で、各置き物の点にいちばん近いレールの位置", () => {
      const rail = createRail(line, [
        { id: "contact", point: [1, 0, -4] },
        { id: "nameplate", point: [-1, 0, -1] },
      ]);
      expect(rail.stops.map((s) => s.id)).toEqual(["nameplate", "contact"]);
      expect(rail.stops[0].t).toBeCloseTo(0.25);
      expect(rail.stops[1].t).toBeCloseTo(1);
    });

    it("nextStop・prevStop は今の t の次・前の止まる所。端では 1・0", () => {
      const rail = createRail(line, [
        { id: "nameplate", point: [1, 0, -1] },
        { id: "pricing", point: [1, 0, -3] },
      ]);
      expect(rail.nextStop(0)).toBeCloseTo(0.25);
      expect(rail.nextStop(0.25)).toBeCloseTo(0.75);
      expect(rail.nextStop(0.8)).toBe(1);
      expect(rail.prevStop(0.8)).toBeCloseTo(0.75);
      expect(rail.prevStop(0.75)).toBeCloseTo(0.25);
      expect(rail.prevStop(0.2)).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: t が範囲外・NaN なら 0〜1 に収める", () => {
      const rail = createRail(line, []);
      close(rail.at(-1).position, [0, 0, 0]);
      close(rail.at(2).position, [0, 0, -4]);
      close(rail.at(Number.NaN).position, [0, 0, 0]);
    });

    it("入力: 点が 2 つ未満なら Error", () => {
      expect(() => createRail([[0, 0, 0]], [])).toThrow();
    });

    it("空入力: stops が空なら nextStop は 1、prevStop は 0", () => {
      const rail = createRail(line, []);
      expect(rail.nextStop(0.5)).toBe(1);
      expect(rail.prevStop(0.5)).toBe(0);
    });
  });
});

// 2026-10-30（ユーザーの指示）: 右側だけでなく左側も通れるように、道を 2 本（右＝lane 0・左＝lane 1）にする。
// 左の道は、glb の各点を x 方向にずらしたもの（leftDx。点の数と同じ）。t は 2 本で共通（弧長は右の道で測る）。
// 2 本が大きく離れている所（アバターのそば）では道を替えない（替えるとカメラがアバターを横切る）。
describe("createRail の 2 本の道", () => {
  const path: [number, number, number][] = [
    [0, 0, 0],
    [1, 0, -2],
    [0, 0, -4],
  ];
  // 真ん中の点だけ左へ 2m（右の道は x=1、左の道は x=-1）
  const leftDx = [0, -2, 0];

  describe("正常系", () => {
    it("at(t, 1) は左の道、at(t, 0) は右の道、at(t, 0.5) はその間。端では 2 本が同じ位置", () => {
      const rail = createRail(path, [], leftDx);
      const mid = 0.5;
      close(rail.at(mid, 0).position, [1, 0, -2]);
      close(rail.at(mid, 1).position, [-1, 0, -2]);
      close(rail.at(mid, 0.5).position, [0, 0, -2]);
      close(rail.at(0, 1).position, rail.at(0, 0).position);
      close(rail.at(1, 1).position, rail.at(1, 0).position);
    });

    it("laneGap(t) は 2 本の道の離れ（m）。canSwitch(t) は離れが 1.2m 以下の所だけ true", () => {
      const rail = createRail(path, [], leftDx);
      expect(rail.laneGap(0)).toBeCloseTo(0, 5);
      expect(rail.laneGap(0.5)).toBeCloseTo(2, 5);
      expect(rail.canSwitch(0)).toBe(true);
      expect(rail.canSwitch(0.5)).toBe(false);
      expect(rail.canSwitch(1)).toBe(true);
    });

    it("forward は 2 本の向きを混ぜた単位ベクトル", () => {
      const rail = createRail(path, [], leftDx);
      const f = rail.at(0.25, 1).forward;
      expect(Math.hypot(...f)).toBeCloseTo(1, 5);
      // 左の道の前半は左前（-x・-z）へ進む
      expect(f[0]).toBeLessThan(0);
      expect(f[2]).toBeLessThan(0);
    });
  });

  describe("異常系", () => {
    it("空入力: leftDx を渡さなければ 1 本の道（at(t, 1) も右の道と同じ・どこでも道を替えられる）", () => {
      const rail = createRail(path, []);
      close(rail.at(0.5, 1).position, rail.at(0.5, 0).position);
      expect(rail.canSwitch(0.5)).toBe(true);
    });

    it("入力: leftDx の数が点の数と違えば Error", () => {
      expect(() => createRail(path, [], [0, -2])).toThrow();
    });

    it("入力: lane が範囲外・NaN なら 0〜1 に収める", () => {
      const rail = createRail(path, [], leftDx);
      close(rail.at(0.5, 3).position, rail.at(0.5, 1).position);
      close(rail.at(0.5, Number.NaN).position, rail.at(0.5, 0).position);
    });
  });
});
