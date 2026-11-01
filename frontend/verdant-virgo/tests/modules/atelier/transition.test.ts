import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterFlight, readVt, writeVt, type AtelierVt } from "@/modules/atelier/client";

// Tips から下層ページへの受け渡し（spec §9 の 3。計画 Task 8）。トップの島が移る直前に書き、行き先の静止画の inline script が読む。
// 行き先が合い、2 秒以内のものだけを読み、読んだら消す（戻ってきたとき・別のページで残りを使わない）。

const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

const vt: AtelierVt = { from: "top", to: "pricing", phase: "dusk", at: 1_000 };

describe("writeVt・readVt", () => {
  describe("正常系", () => {
    it("書いた行き先と同じページで 2 秒以内なら読める・読んだら消える", () => {
      const s = memory();
      writeVt(s, vt);
      expect(readVt(s, "pricing", 2_500)).toEqual(vt);
      expect(readVt(s, "pricing", 2_600)).toBeNull();
      expect(s.map.size).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: 行き先が違う・2 秒を超えた・壊れた JSON は null", () => {
      const s = memory();
      writeVt(s, vt);
      expect(readVt(s, "blog", 1_500)).toBeNull();
      writeVt(s, vt);
      expect(readVt(s, "pricing", 3_100)).toBeNull();
      s.map.set("atelier:vt", "{not json");
      expect(readVt(s, "pricing", 1_100)).toBeNull();
    });

    it("入力: storage が null・投げるときも null で投げない", () => {
      expect(readVt(null, "pricing", 1_000)).toBeNull();
      expect(() => writeVt(null, vt)).not.toThrow();
      const broken = {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      };
      expect(() => writeVt(broken, vt)).not.toThrow();
      expect(readVt(broken, "pricing", 1_000)).toBeNull();
    });

    it("空入力: 何も書いていなければ null", () => {
      expect(readVt(memory(), "pricing", 1_000)).toBeNull();
    });
  });
});

// Tips の「見る」でカメラが飛ぶ間に、遅い端末の判定で描画が止まっても（飛ぶのが終わらなくても）、上限の時間で必ず移る（最終レビュー I-2）
describe("afterFlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("正常系", () => {
    it("飛ぶのが上限より早く終われば、そこで解決する", async () => {
      let done = false;
      const p = afterFlight(new Promise<void>((r) => setTimeout(r, 300)), 1_000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: 飛ぶのが終わらない（描画が止まった）ときは、上限の時間で解決する", async () => {
      let done = false;
      const p = afterFlight(new Promise<void>(() => {}), 1_000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    });

    it("入力: 飛ぶのが失敗（reject）しても、投げずに解決する", async () => {
      await expect(afterFlight(Promise.reject(new Error("disposed")), 1_000)).resolves.toBeUndefined();
    });
  });
});
