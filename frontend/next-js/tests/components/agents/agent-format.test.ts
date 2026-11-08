import { describe, expect, it } from "vitest";
import { firstSentence, serverLabel, shortToolName, toolAccessLabel } from "@/components/agents/agent-format";

describe("firstSentence", () => {
  describe("正常系", () => {
    it("最初の「。」までを返す", () => {
      expect(firstSentence("観測する。提案はしない。")).toBe("観測する。");
    });
    it("「。」が無ければ全文", () => {
      expect(firstSentence("観測する")).toBe("観測する");
    });
    it("括弧（（〈「【）の中の「。」では切らない（2026-11-06 の最終レビュー。実在の定義 4 本がそうなっていた）", () => {
      expect(firstSentence("採用済みの E-01 から構成案を作り、E-03（Strapi の content-plan。plan_state は drafted）として起案する。採否は R2 が決める。")).toBe(
        "採用済みの E-01 から構成案を作り、E-03（Strapi の content-plan。plan_state は drafted）として起案する。",
      );
      expect(firstSentence("「a。b」と〈c。d〉と【e。f】を読む。次。")).toBe("「a。b」と〈c。d〉と【e。f】を読む。");
    });
    it("入れ子の括弧も数える", () => {
      expect(firstSentence("A（B（C。D）E。F）G。H。")).toBe("A（B（C。D）E。F）G。");
    });
    it("空入力: 空文字は空文字", () => {
      expect(firstSentence("  ")).toBe("");
    });
  });
});

describe("serverLabel と shortToolName", () => {
  describe("正常系", () => {
    it("server が null なら組み込みのツール", () => {
      expect(serverLabel({ server: null })).toBe("組み込みのツール");
      expect(serverLabel({ server: "openseo" })).toBe("openseo");
    });
    it("完全名から接続先の部分を外す", () => {
      expect(shortToolName("mcp__chatwoot-prod__chatwoot_add_private_note")).toBe("chatwoot_add_private_note");
      expect(shortToolName("Read")).toBe("Read");
    });
  });
  describe("異常系", () => {
    it("入力: 閉じない括弧があれば、深さ 0 の「。」が無いので全文を返す", () => {
      expect(firstSentence("A（B。C。")).toBe("A（B。C。");
    });
    it("入力: mcp__ の形でも接続先の名前が不正なら外さない", () => {
      expect(shortToolName("mcp__Bad__x")).toBe("mcp__Bad__x");
    });
  });
});

describe("toolAccessLabel", () => {
  describe("正常系", () => {
    it("組み込みの書き込み（Write・Edit）は「ファイルへの書き込み（作業ツリーの中だけ）」（設計 7 節）", () => {
      expect(toolAccessLabel(null, "write")).toBe("ファイルへの書き込み（作業ツリーの中だけ）");
    });
    it("MCP の書き込みは「書き込み」、参照は「参照」、不明は「不明」", () => {
      expect(toolAccessLabel("chatwoot-prod", "write")).toBe("書き込み");
      expect(toolAccessLabel("openseo", "read")).toBe("参照");
      expect(toolAccessLabel(null, "read")).toBe("参照");
      expect(toolAccessLabel(null, "unknown")).toBe("不明");
    });
  });
});
