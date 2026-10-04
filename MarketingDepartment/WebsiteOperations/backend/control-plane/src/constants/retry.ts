// 再試行の表（DD-01 の 5.2〜5.4）。連携ごとに上書きしてよいのは「回数」だけで、「しない」を「する」に変えてはいけない。
import type { FailureClass } from "../contract.js";
import type { Upstream } from "./failure.js";

export interface RetryRule {
  /** 再試行する分類か */
  retry: boolean;
  /** 初回を除く再試行の回数 */
  maxRetries: number;
  /** 再試行ごとの待ち時間（ミリ秒）。rate_limited は Retry-After で決まるため null */
  delaysMs: readonly number[] | null;
  /** 同じ条件では同じ結果になるため、呼び出し側が条件を狭めて取り直す（truncated） */
  callerNarrows?: boolean;
}

export const RETRY_RULES: Readonly<Record<FailureClass, RetryRule>> = {
  ok: { retry: false, maxRetries: 0, delaysMs: null },
  empty_but_ok: { retry: false, maxRetries: 0, delaysMs: null },
  // 3 倍刻みにするのは、合計 12 秒が Chatwoot のタイムアウト（12 秒）と同じ桁に収まるため
  unreachable: { retry: true, maxRetries: 2, delaysMs: [3_000, 9_000] },
  timeout: { retry: true, maxRetries: 1, delaysMs: [3_000] },
  rate_limited: { retry: true, maxRetries: 1, delaysMs: null },
  // auth_failed は上流ごと（AUTH_FAILED_RETRIES）
  auth_failed: { retry: false, maxRetries: 0, delaysMs: null },
  truncated: { retry: true, maxRetries: 1, delaysMs: [0], callerNarrows: true },
  permission_denied: { retry: false, maxRetries: 0, delaysMs: null },
  invalid_response: { retry: false, maxRetries: 0, delaysMs: null },
};

/**
 * 再試行の総予算（1 連携あたり）。すべての分類に適用する。
 * rate_limited は待ち（Retry-After、無ければ 60 秒）が残りの予算に収まるときだけ 1 回再試行し、収まらなければ
 * 待たずに rate_limited の失敗として返す（次の定期実行に任せる）。上流の指定より短く待って送り直すことはしない。
 */
export const RETRY_TOTAL_BUDGET_MS = 30_000;

/** rate_limited で Retry-After が無いときの待ち（5.2） */
export const RATE_LIMIT_DEFAULT_DELAY_MS = 60_000;

/** auth_failed の再試行回数（5.3）。Mautic だけ、トークンを再取得してから 1 回。 */
export const AUTH_FAILED_RETRIES: Readonly<Record<Upstream, number>> = {
  mautic: 1,
  chatwoot: 0,
  github: 0,
  gsc: 0,
  dataforseo: 0,
  aws: 0,
  other: 0,
};

/** Chatwoot 起動直後の 500（5.4）。最初のリクエストだけ、3 秒待って 1 度だけ再試行する。 */
export const CHATWOOT_FIRST_500_RETRY_DELAY_MS = 3_000;

/** 再試行までの待ち時間。これ以上再試行しないなら null。retryIndex は 0 始まり（その分類での再試行の回数）。 */
export function delayBeforeRetry(
  failureClass: FailureClass,
  retryIndex: number,
  retryAfterSec?: number,
): number | null {
  const rule = RETRY_RULES[failureClass];
  if (!rule.retry || retryIndex >= rule.maxRetries) return null;
  if (failureClass === "rate_limited") {
    return Math.max((retryAfterSec ?? RATE_LIMIT_DEFAULT_DELAY_MS / 1000) * 1000, 0);
  }
  return rule.delaysMs?.[retryIndex] ?? null;
}
