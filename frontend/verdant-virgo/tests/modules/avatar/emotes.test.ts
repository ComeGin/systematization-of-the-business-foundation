import { describe, expect, it } from "vitest";
import { createEmoteScheduler, EMOTE_TABLE, IDLE_AFTER_MS } from "@/modules/avatar/lib/emotes";

// エモートのスケジューラー（合図 → エモート）。時刻は引数で渡すので、時計のモックは要らない。

describe("EMOTE_TABLE", () => {
  describe("正常系", () => {
    it("vivid は 5 つの合図に応え、calm は着いた・送信できたの 2 つだけ", () => {
      expect(EMOTE_TABLE.vivid).toEqual({
        arrive: "greeting",
        "reach-pricing": "nod",
        "cta-intent": "point",
        "form-success": "peace",
        idle: "think",
      });
      expect(EMOTE_TABLE.calm).toEqual({ arrive: "greeting", "form-success": "peace" });
    });
    it("何もしない間の長さは 15 秒", () => {
      expect(IDLE_AFTER_MS).toBe(15_000);
    });
  });
});

describe("createEmoteScheduler", () => {
  describe("正常系", () => {
    it("vivid: 着いたら greeting、料金で nod、CTA で point", () => {
      const s = createEmoteScheduler("vivid");
      expect(s.request("arrive", 0)).toBe("greeting");
      expect(s.request("reach-pricing", 4_000)).toBe("nod");
      expect(s.request("cta-intent", 8_000)).toBe("point");
    });
    it("calm: 料金・CTA・idle では何もしない", () => {
      const s = createEmoteScheduler("calm");
      for (const t of ["reach-pricing", "cta-intent", "idle"] as const) expect(s.request(t, 0)).toBeNull();
    });
    it("calm: 送信できたら peace", () => {
      const s = createEmoteScheduler("calm");
      expect(s.request("form-success", 0)).toBe("peace");
    });
    it("idle は think → show-full-body の交互", () => {
      const s = createEmoteScheduler("vivid");
      expect(s.request("idle", 0)).toBe("think");
      expect(s.request("idle", 30_000)).toBe("show-full-body");
      expect(s.request("idle", 60_000)).toBe("think");
    });
    it("playMs を渡すと、長さの表に無いエモートはその間だけ次を受けない", () => {
      const s = createEmoteScheduler("vivid", { playMs: 5_000 });
      s.request("arrive", 0);
      expect(s.request("cta-intent", 4_999)).toBeNull();
      expect(s.request("cta-intent", 5_000)).toBe("point");
    });
    it("エモートごとの長さで受けない（nod の 1.7 秒後には point を受ける）", () => {
      const s = createEmoteScheduler("vivid", { durationsMs: { nod: 1_700, point: 6_000, think: 13_000 } });
      expect(s.request("reach-pricing", 0)).toBe("nod");
      expect(s.request("cta-intent", 1_699)).toBeNull();
      expect(s.request("cta-intent", 1_700)).toBe("point");
    });
    it("エモートごとの長さで受けない（think の再生中は受けず、終われば受ける）", () => {
      const s = createEmoteScheduler("vivid", { durationsMs: { think: 13_000 } });
      expect(s.request("idle", 0)).toBe("think");
      expect(s.request("reach-pricing", 12_999)).toBeNull();
      expect(s.request("reach-pricing", 13_000)).toBe("nod");
    });
  });
  describe("異常系", () => {
    it("入力: 再生中（3 秒以内）の合図は捨てる", () => {
      const s = createEmoteScheduler("vivid");
      s.request("arrive", 0);
      expect(s.request("cta-intent", 2_999)).toBeNull();
    });
    it("入力: 同じエモートは 20 秒の間に繰り返さない", () => {
      const s = createEmoteScheduler("vivid");
      s.request("cta-intent", 0);
      expect(s.request("cta-intent", 19_999)).toBeNull();
      expect(s.request("cta-intent", 20_000)).toBe("point");
    });
    it("入力: 捨てた合図では idle の順番が進まない", () => {
      const s = createEmoteScheduler("vivid");
      s.request("arrive", 0);
      expect(s.request("idle", 1_000)).toBeNull();
      expect(s.request("idle", 5_000)).toBe("think");
    });
    it("空入力: durationsMs が {} なら playMs（既定 3 秒）", () => {
      const s = createEmoteScheduler("vivid", { durationsMs: {} });
      s.request("arrive", 0);
      expect(s.request("cta-intent", 2_999)).toBeNull();
      expect(s.request("cta-intent", 3_000)).toBe("point");
    });
    it("空入力: opts を省くと既定値", () => {
      const s = createEmoteScheduler("calm", {});
      expect(s.request("arrive", 0)).toBe("greeting");
    });
  });
});
