import { describe, expect, it } from "vitest";
import { decideQuality } from "@/modules/atelier/client";

// 遅い端末の判定（spec §8）。最初の数秒のフレーム時間の平均で、描画解像度を下げるか、ポスターのまま止めるかを決める。
// 上限は Desktop 2・Mobile 1.5。平均 20ms を超えたら dpr 1、40ms を超えたら止める（カクついたまま動き続けない）。

const frames = (ms: number, n = 30) => Array.from({ length: n }, () => ms);

describe("decideQuality", () => {
  describe("正常系", () => {
    it("平均 20ms 以下なら Desktop は dpr=min(2, deviceDpr)・live", () => {
      expect(
        decideQuality(frames(16), { mobile: false, deviceDpr: 3 }),
      ).toEqual({ dpr: 2, live: true });
      expect(
        decideQuality(frames(16), { mobile: false, deviceDpr: 1.25 }),
      ).toEqual({ dpr: 1.25, live: true });
    });

    it("平均 20ms 以下なら Mobile は dpr=min(1.5, deviceDpr)・live", () => {
      expect(decideQuality(frames(16), { mobile: true, deviceDpr: 3 })).toEqual(
        { dpr: 1.5, live: true },
      );
    });

    it("平均が 20ms を超え 40ms 以下なら dpr=1・live", () => {
      expect(
        decideQuality(frames(30), { mobile: false, deviceDpr: 2 }),
      ).toEqual({ dpr: 1, live: true });
      expect(decideQuality(frames(40), { mobile: true, deviceDpr: 2 })).toEqual(
        { dpr: 1, live: true },
      );
    });

    it("1 回の長い停止（ほかの読み込みで 2 秒）があっても、ほとんどのフレームが速ければ live（中央値で判定する）", () => {
      expect(decideQuality([2000, ...frames(16, 60)], { mobile: false, deviceDpr: 2 })).toEqual({ dpr: 2, live: true });
    });

    it("平均が 40ms を超えたら live=false（ポスターのまま）", () => {
      expect(
        decideQuality(frames(41), { mobile: false, deviceDpr: 2 }).live,
      ).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: NaN・負の値は捨てて平均する", () => {
      expect(
        decideQuality([16, Number.NaN, -5, 16], {
          mobile: false,
          deviceDpr: 2,
        }),
      ).toEqual({ dpr: 2, live: true });
    });
  });

  it("空入力: フレームが 0 本なら初期値（上限内）で live", () => {
    expect(decideQuality([], { mobile: false, deviceDpr: 3 })).toEqual({
      dpr: 2,
      live: true,
    });
    expect(decideQuality([], { mobile: true, deviceDpr: 3 })).toEqual({
      dpr: 1.5,
      live: true,
    });
  });
});
