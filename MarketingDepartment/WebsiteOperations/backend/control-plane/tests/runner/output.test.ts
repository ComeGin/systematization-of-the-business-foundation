import { describe, expect, it } from "vitest";
import { parseAgentOutput } from "../../src/runner/output.js";

describe("parseAgentOutput", () => {
  describe("正常系", () => {
    it("SUMMARY 行と末尾の TARGET_IDS 行を取り出す", () => {
      const output = parseAgentOutput("SUMMARY: 監査を 3 件書いた\n本文\nTARGET_IDS: AUD-2026-1004-gsc-0001, E-04:abc");
      expect(output).toEqual({ summary: "監査を 3 件書いた", targetIds: ["AUD-2026-1004-gsc-0001", "E-04:abc"] });
    });

    it("SUMMARY は最初の行、TARGET_IDS は最後の行を採る", () => {
      const output = parseAgentOutput("SUMMARY: 1 つ目\nSUMMARY: 2 つ目\nTARGET_IDS: a\nTARGET_IDS: b");
      expect(output.summary).toBe("1 つ目");
      expect(output.targetIds).toEqual(["b"]);
    });

    it("CRLF と行頭の空白を許す", () => {
      const output = parseAgentOutput("  SUMMARY: 要約 \r\n  TARGET_IDS: x \r\n");
      expect(output).toEqual({ summary: "要約", targetIds: ["x"] });
    });

    it("空入力: null・undefined・空文字なら summary は null、targetIds は空", () => {
      expect(parseAgentOutput(null)).toEqual({ summary: null, targetIds: [] });
      expect(parseAgentOutput(undefined)).toEqual({ summary: null, targetIds: [] });
      expect(parseAgentOutput("")).toEqual({ summary: null, targetIds: [] });
    });

    it("空入力: TARGET_IDS 行が空・カンマだけなら targetIds は空", () => {
      expect(parseAgentOutput("SUMMARY: s\nTARGET_IDS:").targetIds).toEqual([]);
      expect(parseAgentOutput("SUMMARY: s\nTARGET_IDS: , ,").targetIds).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: SUMMARY 行が無い・中身が空白だけなら summary は null", () => {
      expect(parseAgentOutput("何か出力した").summary).toBeNull();
      expect(parseAgentOutput("SUMMARY:    ").summary).toBeNull();
    });

    it("入力: メールアドレスや空白を含む ID は落とす（人は ID で指す規則の最後の砦）", () => {
      const output = parseAgentOutput("TARGET_IDS: taro@example.com, 山田 太郎, chatwoot-conversation:12, display_id=3#a");
      expect(output.targetIds).toEqual(["chatwoot-conversation:12", "display_id=3#a"]);
    });

    it("入力: 201 文字以上の ID は落とす", () => {
      const output = parseAgentOutput(`TARGET_IDS: ${"a".repeat(200)}, ${"b".repeat(201)}`);
      expect(output.targetIds).toEqual(["a".repeat(200)]);
    });

    it("入力: 重複を除き、最大 200 件に切る", () => {
      const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
      const output = parseAgentOutput(`TARGET_IDS: id-0, id-0, ${ids.join(",")}`);
      expect(output.targetIds).toHaveLength(200);
      expect(output.targetIds[0]).toBe("id-0");
      expect(new Set(output.targetIds).size).toBe(200);
    });

    it("入力: 行の途中に書かれた SUMMARY: は要約として採らない（行頭だけ）", () => {
      expect(parseAgentOutput("結果は SUMMARY: ではない").summary).toBeNull();
    });
  });
});
