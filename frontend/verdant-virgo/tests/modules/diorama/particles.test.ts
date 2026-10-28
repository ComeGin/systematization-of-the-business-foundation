import { describe, expect, it } from "vitest";
import {
  FLOWS,
  createParticleSystem,
  STAGE_COLOR,
  type FlowId,
} from "@/modules/diorama/client";

// 光の粒の状態機械（three に依存しない）。粒は経路の区間を legMs ずつ進み、色（stage）は区間の始点の段の stage。
// 承認台を通る前に承認済み（金）の粒が出ない・サイトには承認済みの粒だけが届く、が論理の約束（spec §5.2）。

const LEG = 1000;
const quiet = { legMs: LEG, spawnEveryMs: {} };

describe("createParticleSystem", () => {
  describe("正常系", () => {
    it("粒の stage は、いまいる区間の始点の stage", () => {
      const sys = createParticleSystem(quiet);
      sys.spawn("improveSite");
      const flow = FLOWS.improveSite;
      for (let leg = 0; leg < flow.length - 1; leg++) {
        const [p] = sys.step(LEG / 2);
        expect(p.step).toBe(leg);
        expect(p.stage).toBe(flow[leg].stage);
        sys.step(LEG / 2);
      }
    });

    it("approved になるのは approval に着いた後だけ", () => {
      const sys = createParticleSystem(quiet);
      const ids = Object.keys(FLOWS) as FlowId[];
      ids.forEach((id) => sys.spawn(id));
      for (let i = 0; i < 100; i++) {
        for (const p of sys.step(LEG / 10)) {
          const passed = FLOWS[p.flow]
            .slice(0, p.step + 1)
            .some((s) => s.part === "approval");
          if (p.stage === "approved") expect(passed).toBe(true);
        }
      }
    });

    it("site への到着は approved だけ", () => {
      const sys = createParticleSystem(quiet);
      (Object.keys(FLOWS) as FlowId[]).forEach((id) => sys.spawn(id));
      const arrivals = [];
      for (let i = 0; i < 100; i++) {
        sys.step(LEG / 4);
        arrivals.push(...sys.arrivals());
      }
      const atSite = arrivals.filter((a) => a.part === "site");
      expect(atSite.length).toBeGreaterThan(0);
      expect(atSite.every((a) => a.stage === "approved")).toBe(true);
    });

    it("最後の区間を終えた粒は消える", () => {
      const sys = createParticleSystem(quiet);
      sys.spawn("inquiryChat"); // 2 段 → 区間は 1 つ
      expect(sys.step(LEG / 2)).toHaveLength(1);
      expect(sys.step(LEG)).toHaveLength(0);
    });

    it("spawnEveryMs の間隔で自動で生まれる", () => {
      const sys = createParticleSystem({
        legMs: LEG,
        spawnEveryMs: { inquiryForm: 500 },
        random: () => 0,
      });
      sys.step(499);
      expect(sys.step(0)).toHaveLength(0);
      expect(sys.step(1).filter((p) => p.flow === "inquiryForm")).toHaveLength(
        1,
      );
    });

    it("色は白・ブランドの青・金", () => {
      expect(STAGE_COLOR).toEqual({
        inflow: "#FFFFFF",
        proposal: "#1298E8",
        approved: "#FFD27A",
      });
    });
  });

  describe("異常系", () => {
    it("入力: 負の dt は 0 として扱う", () => {
      const sys = createParticleSystem(quiet);
      sys.spawn("article");
      const [p] = sys.step(-500);
      expect(p.t).toBe(0);
      expect(p.step).toBe(0);
    });

    it("入力: 巨大な dt（タブ復帰の 60 秒）でも 1 回の step で進むのは 1 区間まで", () => {
      const sys = createParticleSystem(quiet);
      sys.spawn("article");
      const [p] = sys.step(60_000);
      expect(p.step).toBe(1);
      expect(p.t).toBe(0);
    });
  });

  it("空入力: dt が 0 なら何も進まない", () => {
    const sys = createParticleSystem(quiet);
    sys.spawn("article");
    const [p] = sys.step(0);
    expect(p).toMatchObject({ step: 0, t: 0 });
    expect(sys.arrivals()).toEqual([]);
  });
});
