import { describe, expect, it } from "vitest";
import {
  PHASE_BOUNDS,
  PHASE_LIGHTS,
  phaseAt,
  visitPhase,
  type Phase,
} from "@/modules/atelier/client";

// 空と時間帯（spec §5.3）。端末の現地時刻で決め、1 回の訪問の中では sessionStorage の atelier:phase で固定する。

const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m);

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

describe("phaseAt", () => {
  describe("正常系", () => {
    it("phaseAt は境目で切り替わる", () => {
      const cases: [number, number, Phase][] = [
        [4, 59, "night"],
        [5, 0, "morning"],
        [9, 59, "morning"],
        [10, 0, "day"],
        [15, 59, "day"],
        [16, 0, "dusk"],
        [18, 59, "dusk"],
        [19, 0, "night"],
        [0, 0, "night"],
      ];
      for (const [h, m, phase] of cases) expect(phaseAt(at(h, m))).toBe(phase);
      expect(PHASE_BOUNDS.map((b) => b.from)).toEqual([5, 10, 16, 19]);
    });
  });
});

describe("visitPhase", () => {
  describe("正常系", () => {
    it("visitPhase は最初の呼び出しで atelier:phase に書き、2 回目以降は時刻が変わっても同じ値を返す", () => {
      const s = memory();
      expect(visitPhase(s, at(18, 59))).toBe("dusk");
      expect(s.map.get("atelier:phase")).toBe("dusk");
      expect(visitPhase(s, at(19, 1))).toBe("dusk");
    });
  });

  describe("異常系", () => {
    it("入力: 保存された値が知らない文字列なら、今の時刻で書き直す", () => {
      const s = memory();
      s.map.set("atelier:phase", "noon");
      expect(visitPhase(s, at(12))).toBe("day");
      expect(s.map.get("atelier:phase")).toBe("day");
    });

    it("入力: storage が null（使えない）なら今の時刻の時間帯を返し、投げない", () => {
      expect(visitPhase(null, at(21))).toBe("night");
    });

    it("入力: storage.setItem が投げても今の時刻の時間帯を返す", () => {
      const s = {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      };
      expect(visitPhase(s, at(6))).toBe("morning");
    });
  });
});

describe("PHASE_LIGHTS", () => {
  describe("正常系", () => {
    it("PHASE_LIGHTS は 4 つの時間帯すべてにあり、夜だけ starfield が true・skyUrlKey が null、夜と夕方は lamps > 0、昼は sun がある", () => {
      const phases: Phase[] = ["morning", "day", "dusk", "night"];
      expect(Object.keys(PHASE_LIGHTS).sort()).toEqual([...phases].sort());
      for (const p of phases) {
        expect(PHASE_LIGHTS[p].starfield).toBe(p === "night");
        expect(PHASE_LIGHTS[p].skyUrlKey).toBe(p === "night" ? null : p);
      }
      expect(PHASE_LIGHTS.night.lamps).toBeGreaterThan(0);
      expect(PHASE_LIGHTS.dusk.lamps).toBeGreaterThan(0);
      expect(PHASE_LIGHTS.day.sun).not.toBeNull();
    });
  });
});
