import { describe, expect, it } from "vitest";
import { CONTROL_TIMEOUT_SEC, MANUAL_AGENT_DEFAULTS, TIMEOUT_SEC } from "../../src/constants/timeouts.js";

// 定数表の検査（異常の起こりようが無いため正常系だけ）
describe("TIMEOUT_SEC（DD-01 の 7.2）", () => {
  describe("正常系", () => {
    it("Chatwoot は Rack::Timeout の 15 秒より内側（12 秒）", () => {
      expect(TIMEOUT_SEC.chatwootMcp).toBe(12);
      expect(TIMEOUT_SEC.chatwootMcp).toBeLessThan(15);
    });

    it("Umami は ADR-25（2026-10-06）で廃止したため、表に無い", () => {
      expect(TIMEOUT_SEC).not.toHaveProperty("umamiMcp");
      expect(Object.keys(TIMEOUT_SEC).some((key) => /umami/i.test(key))).toBe(false);
    });

    it("I-13（GitHub）は 30 秒", () => {
      expect(TIMEOUT_SEC.i13Github).toBe(30);
    });

    it("すべて正の秒数", () => {
      for (const [key, value] of Object.entries(TIMEOUT_SEC)) expect({ key, positive: value > 0 }).toEqual({ key, positive: true });
    });
  });
});

describe("CONTROL_TIMEOUT_SEC", () => {
  describe("正常系", () => {
    it("Chatwoot の読み取りは I-03 と同じ上流なので chatwootMcp と同じ値", () => {
      expect(CONTROL_TIMEOUT_SEC.chatwootRead).toBe(TIMEOUT_SEC.chatwootMcp);
    });

    it("n8n の Public API（n8n-export）は 1 回の呼び出しごとに 30 秒", () => {
      expect(CONTROL_TIMEOUT_SEC.n8nApi).toBe(30);
    });

    it("S3 への写しは 30 秒、CloudWatch は 10 秒", () => {
      expect(CONTROL_TIMEOUT_SEC.s3Put).toBe(30);
      expect(CONTROL_TIMEOUT_SEC.cloudwatchPut).toBe(10);
    });
  });
});

describe("MANUAL_AGENT_DEFAULTS", () => {
  describe("正常系", () => {
    it("手動起動の既定は 900 秒・40 ターン", () => {
      expect(MANUAL_AGENT_DEFAULTS).toEqual({ timeoutSec: 900, maxTurns: 40 });
    });
  });
});
