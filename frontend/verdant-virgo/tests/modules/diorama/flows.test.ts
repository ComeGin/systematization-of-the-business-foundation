import { describe, expect, it } from "vitest";
import {
  FLOWS,
  assertFlowsLogical,
  type FlowStep,
} from "@/modules/diorama/client";

// 光の粒の経路（spec §5.2）。経路は docs/DetailedDesign の実際の流れと一致させ、承認を飛ばして作用する流れを作らない。
// 各段の stage は、粒がその部品を「出るとき」の段階（inflow＝流れ込み・proposal＝提案・approved＝承認済み）。

const steps = (...pairs: [FlowStep["part"], FlowStep["stage"]][]): FlowStep[] =>
  pairs.map(([part, stage]) => ({ part, stage }));

describe("FLOWS", () => {
  describe("正常系", () => {
    it("FLOWS は assertFlowsLogical を通る", () => {
      expect(() => assertFlowsLogical(FLOWS)).not.toThrow();
    });

    it("site に届く流れは、直前が shipping、その前のどこかに approval がある", () => {
      for (const flow of Object.values(FLOWS)) {
        flow.forEach((step, i) => {
          if (step.part !== "site") return;
          expect(flow[i - 1]?.part).toBe("shipping");
          expect(flow.slice(0, i).some((s) => s.part === "approval")).toBe(
            true,
          );
        });
      }
    });

    it("improveCrm は承認台の後に名簿で、improveChat は承認台の後に窓口で終わる", () => {
      expect(FLOWS.improveCrm.map((s) => s.part).slice(-2)).toEqual([
        "approval",
        "roster",
      ]);
      expect(FLOWS.improveChat.map((s) => s.part).slice(-2)).toEqual([
        "approval",
        "desk",
      ]);
    });

    it("フォームの問い合わせは窓口 → 名簿 → 配管の順（I-08・I-11）", () => {
      expect(FLOWS.inquiryForm.map((s) => s.part)).toEqual([
        "desk",
        "roster",
        "pipe",
      ]);
    });

    it("チャットの問い合わせは窓口 → 配管（I-12）", () => {
      expect(FLOWS.inquiryChat.map((s) => s.part)).toEqual(["desk", "pipe"]);
    });
  });

  describe("異常系", () => {
    it("入力: approval を通らず approved になる流れは拒む", () => {
      expect(() =>
        assertFlowsLogical({
          x: steps(["agents", "proposal"], ["roster", "approved"]),
        }),
      ).toThrow(/x.*approval/);
    });

    it("入力: stage が戻る流れは拒む", () => {
      expect(() =>
        assertFlowsLogical({
          y: steps(
            ["agents", "proposal"],
            ["approval", "approved"],
            ["shelf", "proposal"],
          ),
        }),
      ).toThrow(/y.*戻/);
    });

    it("入力: shipping を通らず site に届く流れは拒む", () => {
      expect(() =>
        assertFlowsLogical({
          z: steps(
            ["agents", "proposal"],
            ["approval", "approved"],
            ["site", "approved"],
          ),
        }),
      ).toThrow(/z.*shipping/);
    });

    it("入力: proposal のまま shipping を通って site に届く流れは拒む", () => {
      expect(() =>
        assertFlowsLogical({
          w: steps(
            ["agents", "proposal"],
            ["shipping", "proposal"],
            ["site", "proposal"],
          ),
        }),
      ).toThrow(/w.*approved/);
    });

    it("入力: 存在しない部品を含む流れは拒む", () => {
      expect(() =>
        assertFlowsLogical({
          v: [{ part: "garage" as FlowStep["part"], stage: "inflow" }],
        }),
      ).toThrow(/v.*garage/);
    });
  });

  it("空入力: 空の流れは拒む", () => {
    expect(() => assertFlowsLogical({ x: [] })).toThrow(/x/);
  });
});
