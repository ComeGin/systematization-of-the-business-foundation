import { describe, expect, it } from "vitest";
import { layoutMarkers } from "@/modules/atelier/client";

// 押せる部品の点の置き方（WCAG 2.5.8 ターゲットの大きさ・2.1.1 キーボード）。
// 点どうしを minGap 以上離し、枠の中（margin の内側）に収める。枠の外の部品も隠さず、端に寄せて押せるようにする。

const opts = { width: 800, height: 450, margin: 20, minGap: 34 };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutMarkers", () => {
  describe("正常系", () => {
    it("離れている点は動かさない", () => {
      const out = layoutMarkers(
        [
          { id: "a", x: 100, y: 100 },
          { id: "b", x: 300, y: 200 },
        ],
        opts,
      );
      expect(out).toEqual([
        { id: "a", x: 100, y: 100 },
        { id: "b", x: 300, y: 200 },
      ]);
    });

    it("近すぎる 2 点は minGap 以上に離し、それぞれの移動は minGap 以内", () => {
      const out = layoutMarkers(
        [
          { id: "a", x: 400, y: 200 },
          { id: "b", x: 410, y: 205 },
        ],
        opts,
      );
      expect(dist(out[0], out[1])).toBeGreaterThanOrEqual(34 - 0.5);
      expect(dist(out[0], { x: 400, y: 200 })).toBeLessThanOrEqual(34);
      expect(dist(out[1], { x: 410, y: 205 })).toBeLessThanOrEqual(34);
    });

    it("3 点が固まっていても、すべての組が minGap 以上離れる", () => {
      const out = layoutMarkers(
        [
          { id: "a", x: 400, y: 200 },
          { id: "b", x: 405, y: 200 },
          { id: "c", x: 402, y: 206 },
        ],
        opts,
      );
      for (let i = 0; i < out.length; i++)
        for (let j = i + 1; j < out.length; j++)
          expect(dist(out[i], out[j])).toBeGreaterThanOrEqual(34 - 0.5);
    });

    it("枠の外の点は隠さず、枠の内側（margin）に寄せる", () => {
      const out = layoutMarkers([{ id: "a", x: 900, y: -40 }], opts);
      expect(out).toEqual([{ id: "a", x: 780, y: 20 }]);
    });
  });

  describe("異常系", () => {
    it("入力: 同じ位置の 2 点（向きが決まらない）も離す", () => {
      const out = layoutMarkers(
        [
          { id: "a", x: 400, y: 200 },
          { id: "b", x: 400, y: 200 },
        ],
        opts,
      );
      expect(dist(out[0], out[1])).toBeGreaterThanOrEqual(34 - 0.5);
    });

    it("入力: NaN の座標は枠の中央に置く", () => {
      const out = layoutMarkers([{ id: "a", x: Number.NaN, y: 100 }], opts);
      expect(out[0]).toEqual({ id: "a", x: 400, y: 100 });
    });
  });

  it("空入力: 点が無ければ空を返す", () => {
    expect(layoutMarkers([], opts)).toEqual([]);
  });
});
