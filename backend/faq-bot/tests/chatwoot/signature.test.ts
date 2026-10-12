import { describe, expect, it } from "vitest";
import { verifySignature } from "../../src/chatwoot/signature.js";
import { sign } from "../helpers/chatwoot.js";

const SECRET = "secret-for-tests-0123456789";
const NOW = 1_800_000_000;
const BODY = '{"event":"message_created"}';
const base = (overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) => ({
  secret: SECRET,
  timestamp: String(NOW),
  signature: sign(SECRET, NOW, BODY),
  rawBody: Buffer.from(BODY),
  nowSeconds: NOW,
  toleranceSeconds: 300,
  ...overrides,
});

describe("verifySignature", () => {
  describe("正常系", () => {
    it("正しい署名を通す", () => {
      expect(verifySignature(base())).toEqual({ ok: true });
    });

    it("許容の 300 秒ちょうどのずれは通す", () => {
      expect(verifySignature(base({ nowSeconds: NOW + 300 }))).toEqual({ ok: true });
    });
  });

  describe("異常系", () => {
    it("空入力: ヘッダーが無ければ missing", () => {
      expect(verifySignature(base({ timestamp: undefined }))).toEqual({ ok: false, reason: "missing" });
      expect(verifySignature(base({ signature: "" }))).toEqual({ ok: false, reason: "missing" });
    });

    it("入力: 形式が違えば malformed", () => {
      expect(verifySignature(base({ timestamp: "abc" }))).toEqual({ ok: false, reason: "malformed" });
      expect(verifySignature(base({ signature: "sha1=00" }))).toEqual({ ok: false, reason: "malformed" });
    });

    it("入力: 301 秒以上ずれていれば stale", () => {
      expect(verifySignature(base({ nowSeconds: NOW + 301 }))).toEqual({ ok: false, reason: "stale" });
      expect(verifySignature(base({ nowSeconds: NOW - 301 }))).toEqual({ ok: false, reason: "stale" });
    });

    it("入力: 本文が改ざんされていれば mismatch", () => {
      expect(verifySignature(base({ rawBody: Buffer.from(`${BODY} `) }))).toEqual({ ok: false, reason: "mismatch" });
    });

    it("入力: 鍵が違えば mismatch", () => {
      expect(verifySignature(base({ secret: "another-secret-0123456789" }))).toEqual({ ok: false, reason: "mismatch" });
    });
  });
});
