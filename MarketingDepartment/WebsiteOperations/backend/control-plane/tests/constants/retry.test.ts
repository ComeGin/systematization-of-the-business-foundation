import { describe, expect, it } from "vitest";
import { FAILURE_CLASSES } from "../../src/constants/failure.js";
import { RETRY_RULES, delayBeforeRetry } from "../../src/constants/retry.js";

describe("delayBeforeRetry", () => {
  it("unreachable は 3 秒・9 秒の 2 回だけ", () => {
    expect([0, 1, 2].map((i) => delayBeforeRetry("unreachable", i))).toEqual([3_000, 9_000, null]);
  });

  it("timeout は 3 秒で 1 回だけ", () => {
    expect([0, 1].map((i) => delayBeforeRetry("timeout", i))).toEqual([3_000, null]);
  });

  it("truncated は待たずに 1 回（条件を狭めるのは呼び出し側）", () => {
    expect([0, 1].map((i) => delayBeforeRetry("truncated", i))).toEqual([0, null]);
    expect(RETRY_RULES.truncated.callerNarrows).toBe(true);
  });

  it("rate_limited は Retry-After（秒）に従い、無ければ 60 秒。2 回目は無い", () => {
    expect(delayBeforeRetry("rate_limited", 0, 5)).toBe(5_000);
    expect(delayBeforeRetry("rate_limited", 0)).toBe(60_000);
    expect(delayBeforeRetry("rate_limited", 1, 5)).toBeNull();
  });

  it("負の Retry-After は 0 に丸める", () => {
    expect(delayBeforeRetry("rate_limited", 0, -3)).toBe(0);
  });

  it.each(["ok", "empty_but_ok", "auth_failed", "permission_denied", "invalid_response"] as const)(
    "%s は再試行しない",
    (failureClass) => {
      expect(delayBeforeRetry(failureClass, 0)).toBeNull();
    },
  );

  it("再試行する分類は、回数ぶんの待ち時間が表にある（rate_limited を除く）", () => {
    for (const failureClass of FAILURE_CLASSES) {
      const rule = RETRY_RULES[failureClass];
      if (!rule.retry || failureClass === "rate_limited") continue;
      for (let i = 0; i < rule.maxRetries; i++) {
        expect({ failureClass, i, delay: delayBeforeRetry(failureClass, i) }).not.toMatchObject({ delay: null });
      }
    }
  });
});
