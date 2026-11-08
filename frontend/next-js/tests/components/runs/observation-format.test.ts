import { describe, expect, it } from "vitest";
import { summarizeContent } from "@/components/runs/observation-format";
import { makeObservation, makeObservations } from "../../helpers/control-plane";

describe("summarizeContent", () => {
  describe("正常系", () => {
    it("空入力: 観測の記録が無ければ none", () => {
      expect(summarizeContent(undefined)).toEqual({ kind: "none" });
    });

    it("空入力: written が無ければ none", () => {
      expect(summarizeContent(makeObservations())).toEqual({ kind: "none" });
    });

    it("ok と empty_but_ok だけなら ok", () => {
      const observations = makeObservations({ written: [makeObservation(), makeObservation({ outcome: "empty_but_ok" })] });
      expect(summarizeContent(observations)).toEqual({ kind: "ok", total: 2 });
    });

    it("permission_denied が 1 件あれば failed 1 / 2", () => {
      const observations = makeObservations({ written: [makeObservation(), makeObservation({ outcome: "permission_denied" })] });
      expect(summarizeContent(observations)).toEqual({ kind: "failed", failed: 1, total: 2 });
    });

    it("referenced の失敗は数えない（読んだだけの観測）", () => {
      const observations = makeObservations({ written: [makeObservation()], referenced: [makeObservation({ outcome: "unreachable" })] });
      expect(summarizeContent(observations)).toEqual({ kind: "ok", total: 1 });
    });
  });

  describe("異常系", () => {
    it("入力: outcome が null の観測は失敗として数える", () => {
      expect(summarizeContent(makeObservations({ written: [makeObservation({ outcome: null })] }))).toEqual({ kind: "failed", failed: 1, total: 1 });
    });

    it("入力: 定義に無い分類も失敗として数える", () => {
      expect(summarizeContent(makeObservations({ written: [makeObservation({ outcome: "weird" })] }))).toEqual({ kind: "failed", failed: 1, total: 1 });
    });
  });
});
