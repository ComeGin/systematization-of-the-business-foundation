import { describe, expect, it } from "vitest";
import type { FailureClass } from "../../src/contract.js";
import { FAILURE_CLASSES } from "../../src/constants/failure.js";
import {
  AUTH_FAILED_RETRIES,
  RATE_LIMIT_DEFAULT_DELAY_MS,
  RETRY_RULES,
  RETRY_TOTAL_BUDGET_MS,
  delayBeforeRetry,
} from "../../src/constants/retry.js";

describe("delayBeforeRetry", () => {
  describe("正常系", () => {
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

    it("空入力: retryAfterSec を省くと rate_limited は既定の待ち（RATE_LIMIT_DEFAULT_DELAY_MS）", () => {
      expect(delayBeforeRetry("rate_limited", 0, undefined)).toBe(RATE_LIMIT_DEFAULT_DELAY_MS);
    });

    it("Retry-After が 0 なら待たずに 1 回", () => {
      expect(delayBeforeRetry("rate_limited", 0, 0)).toBe(0);
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

  describe("異常系", () => {
    it("入力: 負の Retry-After は 0 に丸める", () => {
      expect(delayBeforeRetry("rate_limited", 0, -3)).toBe(0);
    });

    it("入力: 回数を超えた retryIndex は null（無限に再試行しない）", () => {
      expect(delayBeforeRetry("unreachable", 99)).toBeNull();
      expect(delayBeforeRetry("rate_limited", 99, 1)).toBeNull();
    });

    it("入力: 再試行しない分類には Retry-After があっても待たない", () => {
      expect(delayBeforeRetry("permission_denied", 0, 5)).toBeNull();
    });
  });
});

describe("再試行の表", () => {
  describe("正常系", () => {
    it("すべての分類に規則がある", () => {
      expect(Object.keys(RETRY_RULES).sort()).toEqual([...FAILURE_CLASSES].sort());
    });

    it("「しない」の分類は回数 0（表の上書きで「する」に変えていない）", () => {
      for (const failureClass of ["ok", "empty_but_ok", "auth_failed", "permission_denied", "invalid_response"] as FailureClass[]) {
        expect(RETRY_RULES[failureClass]).toMatchObject({ retry: false, maxRetries: 0 });
      }
    });

    it("auth_failed の再試行は Mautic の 1 回だけ。総予算は 30 秒", () => {
      expect(Object.entries(AUTH_FAILED_RETRIES).filter(([, count]) => count > 0)).toEqual([["mautic", 1]]);
      expect(RETRY_TOTAL_BUDGET_MS).toBe(30_000);
    });
  });
});
