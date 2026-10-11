import { describe, expect, it } from "vitest";
import { isRunOutcome, ULID } from "@/lib/ids";
import { SAMPLE_RUN_ID } from "../helpers/control-plane";

describe("ULID", () => {
  describe("正常系", () => {
    it.each([
      ["見本の run_id", SAMPLE_RUN_ID],
      ["数字だけ", "0".repeat(26)],
      ["Crockford Base32 の最大の文字だけ", "Z".repeat(26)],
    ])("%s は通す", (_label, value) => {
      expect(ULID.test(value)).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each([
      ["小文字", SAMPLE_RUN_ID.toLowerCase()],
      ["25 文字", SAMPLE_RUN_ID.slice(1)],
      ["27 文字", `${SAMPLE_RUN_ID}0`],
      ["I を含む", `${SAMPLE_RUN_ID.slice(0, 25)}I`],
      ["L を含む", `${SAMPLE_RUN_ID.slice(0, 25)}L`],
      ["O を含む", `${SAMPLE_RUN_ID.slice(0, 25)}O`],
      ["U を含む", `${SAMPLE_RUN_ID.slice(0, 25)}U`],
      ["前後に空白", ` ${SAMPLE_RUN_ID.slice(1)}`],
      ["末尾に改行（$ が行末に合わないこと）", `${SAMPLE_RUN_ID}\n`],
      ["パスの区切りを含む", `../${SAMPLE_RUN_ID.slice(3)}`],
      ["全角の英数字", "０".repeat(26)],
    ])("入力: %s は通さない", (_label, value) => {
      expect(ULID.test(value)).toBe(false);
    });

    it("空入力: 空文字は通さない", () => {
      expect(ULID.test("")).toBe(false);
    });

    it("入力: グローバルフラグを持たない（test を繰り返しても lastIndex で結果が変わらない）", () => {
      expect(ULID.global).toBe(false);
      expect([ULID.test(SAMPLE_RUN_ID), ULID.test(SAMPLE_RUN_ID)]).toEqual([true, true]);
    });
  });
});

describe("isRunOutcome", () => {
  describe("正常系", () => {
    it.each(["success", "failure", "partial", "skipped"])("%s は E-15 の outcome として認める", (value) => {
      expect(isRunOutcome(value)).toBe(true);
    });
  });

  describe("異常系", () => {
    it.each([
      ["status の値（running）", "running"],
      ["大文字", "SUCCESS"],
      ["前後に空白", " success"],
      ["配列（?outcome= を 2 回指定）", ["success", "failure"]],
      ["数値", 1],
      ["オブジェクト", { outcome: "success" }],
    ])("入力: %s は認めない", (_label, value) => {
      expect(isRunOutcome(value)).toBe(false);
    });

    it.each([
      ["空文字", ""],
      ["undefined", undefined],
      ["null", null],
    ])("空入力: %s は認めない", (_label, value) => {
      expect(isRunOutcome(value)).toBe(false);
    });
  });
});
