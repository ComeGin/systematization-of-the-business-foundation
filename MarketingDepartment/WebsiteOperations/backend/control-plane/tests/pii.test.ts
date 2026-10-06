import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_LENGTH, redactSummary } from "../src/pii.js";

describe("redactSummary", () => {
  it("PII が無ければそのまま返し、redacted=false", () => {
    expect(redactSummary("E-12 を 3 件書いた")).toEqual({ text: "E-12 を 3 件書いた", redacted: false });
  });

  it("前後の空白を落とし、改行・連続空白を 1 つの空白にまとめる", () => {
    expect(redactSummary("  1 行目\n\n2 行目\t\t3  ").text).toBe("1 行目 2 行目 3");
  });

  it.each(["taro.yamada+news@example.co.jp", "a_b%c@sub-domain.example.com", "X@Y.IO"])("メールアドレス %s を伏せる", (email) => {
    expect(redactSummary(`連絡先 ${email} に返信した`)).toEqual({
      text: "連絡先 [redacted:email] に返信した",
      redacted: true,
    });
  });

  it.each(["03-1234-5678", "090-1234-5678", "0120.123.456", "09012345678", "0312345678", "(03) 1234-5678", "+81 90-1234-5678", "+81-3-1234-5678"])(
    "電話番号 %s を伏せる",
    (phone) => {
      expect(redactSummary(`電話 ${phone} に折り返し`)).toEqual({ text: "電話 [redacted:phone] に折り返し", redacted: true });
    },
  );

  it.each([
    ["日付", "2026-10-05 に公開"],
    ["タイムゾーン付きの時刻", "2026-10-05T08:00:00+09:00 に実行"],
    ["ULID", "run 01JBQZ8F3K7XN2M5V9TWRC4HED を参照"],
    ["監査 ID", "AUD-2026-1004-lighthouse-0001 を作成"],
    ["版番号", "v0.3.283 に更新"],
    ["件数・金額", "1234567 件、12,345 円"],
    ["英数字に埋もれた 0 始まりの数字列", "id=ab09012345678cd"],
  ])("%s は伏せない（数字列を巻き込まない）", (_label, text) => {
    expect(redactSummary(text)).toEqual({ text, redacted: false });
  });

  it("メールと電話が混ざっていても両方伏せる", () => {
    expect(redactSummary("a@example.com と 03-1234-5678").text).toBe("[redacted:email] と [redacted:phone]");
  });

  it("続けて呼んでも結果が変わらない（g フラグの lastIndex を持ち越さない）", () => {
    const first = redactSummary("03-1234-5678 / a@example.com");
    const second = redactSummary("03-1234-5678 / a@example.com");
    expect(second).toEqual(first);
  });

  it(`${SUMMARY_MAX_LENGTH} 文字を超えたら末尾を … にして ${SUMMARY_MAX_LENGTH} 文字に収める`, () => {
    const result = redactSummary("あ".repeat(SUMMARY_MAX_LENGTH + 10));
    expect(result.text).toHaveLength(SUMMARY_MAX_LENGTH);
    expect(result.text.endsWith("…")).toBe(true);
    expect(redactSummary("あ".repeat(SUMMARY_MAX_LENGTH)).text).toHaveLength(SUMMARY_MAX_LENGTH);
  });

  it("切り詰めより先に伏せる（長文の末尾の PII も残らない）", () => {
    // 切り詰めの位置（500 文字目）をまたぐメールアドレス。先に切ると「taro@ex」が残る
    const result = redactSummary(`${"x".repeat(490)} taro@example.com`);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("taro");
  });
});
