// HTTP の呼び出しに、失敗分類（DD-01 の 4.4）と再試行の表（5.2〜5.4）を適用する共通処理。
// 応答の本文はログにも結果にも残さない（個人情報が混ざりうるため）。成功時の data だけ呼び出し側に返す。
import type { FailureClass } from "../contract.js";
import { type Upstream, classifyResponse, isSuccessClass } from "../constants/failure.js";
import {
  AUTH_FAILED_RETRIES,
  CHATWOOT_FIRST_500_RETRY_DELAY_MS,
  RETRY_RULES,
  RETRY_TOTAL_BUDGET_MS,
  delayBeforeRetry,
} from "../constants/retry.js";

export interface FetchJsonOptions {
  upstream: Upstream;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  /** 外から打ち切る（停止要求など）。打ち切られたら timeout として返す。 */
  signal?: AbortSignal;
  /** Chatwoot 起動直後の 500 だけ例外的に再試行する（5.4）。最初のリクエストのときに true。 */
  firstRequest?: boolean;
  /** トークンの再取得（Mautic の 401。5.3）。無ければ auth_failed は再試行しない。 */
  refreshAuth?: () => Promise<void>;
  isTruncated?: (data: unknown) => boolean;
  countOf?: (data: unknown) => number | undefined;
  /** 再試行の総予算（既定 30 秒） */
  budgetMs?: number;
}

export interface FetchJsonResult<T = unknown> {
  failureClass: FailureClass;
  attempts: number;
  status: number | null;
  data: T | null;
}

/** 失敗分類つきの例外。 */
export class IntegrationError extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

interface Attempt<T> {
  failureClass: FailureClass;
  status: number | null;
  data: T | null;
  retryAfterSec?: number;
}

async function attemptOnce<T>(options: FetchJsonOptions): Promise<Attempt<T>> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  let response: Response;
  let text: string;
  try {
    response = await fetch(options.url, { ...options.init, signal });
    text = await response.text();
  } catch {
    // こちらから切った（タイムアウト・停止要求）か、接続できなかったか
    const timedOut = timeoutSignal.aborted || options.signal?.aborted === true;
    return {
      failureClass: classifyResponse({ upstream: options.upstream, timedOut, connectFailed: !timedOut }),
      status: null,
      data: null,
    };
  }

  // ヘッダーが無い・空のときに Number(null) = 0（即座に再試行）と読まないよう、値があるときだけ数値にする
  const retryAfterHeader = response.headers.get("retry-after")?.trim();
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const retryAfterSec = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;

  let data: unknown = null;
  let parseable = true;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      parseable = false;
    }
  }
  const failureClass = classifyResponse({
    upstream: options.upstream,
    status: response.status,
    truncated: parseable && options.isTruncated?.(data) === true,
    parseable,
    count: parseable ? options.countOf?.(data) : undefined,
  });
  return { failureClass, status: response.status, data: data as T | null, retryAfterSec };
}

export async function fetchJson<T = unknown>(options: FetchJsonOptions): Promise<FetchJsonResult<T>> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? RETRY_TOTAL_BUDGET_MS;
  const retriesByClass = new Map<FailureClass, number>();
  let attempts = 0;
  let authRetries = 0;
  let first500Retried = false;

  for (;;) {
    attempts++;
    const result = await attemptOnce<T>(options);
    const done = (): FetchJsonResult<T> => ({
      failureClass: result.failureClass,
      attempts,
      status: result.status,
      data: isSuccessClass(result.failureClass) ? result.data : null,
    });

    if (isSuccessClass(result.failureClass) || options.signal?.aborted) return done();

    if (options.firstRequest && options.upstream === "chatwoot" && result.status === 500 && !first500Retried) {
      first500Retried = true;
      await sleep(CHATWOOT_FIRST_500_RETRY_DELAY_MS, options.signal);
      continue;
    }

    if (result.failureClass === "auth_failed") {
      if (options.refreshAuth && authRetries < AUTH_FAILED_RETRIES[options.upstream]) {
        authRetries++;
        await options.refreshAuth();
        continue;
      }
      return done();
    }

    // truncated は同じ条件では同じ結果になる。条件を狭めて取り直すのは呼び出し側の仕事
    if (RETRY_RULES[result.failureClass].callerNarrows) return done();

    const used = retriesByClass.get(result.failureClass) ?? 0;
    const delay = delayBeforeRetry(result.failureClass, used, result.retryAfterSec);
    if (delay === null) return done();
    // 総予算（rate_limited を含む）。待ちが残りの予算に収まらなければ、待たずに失敗として返す
    if (Date.now() - started + delay > budgetMs) return done();
    retriesByClass.set(result.failureClass, used + 1);
    await sleep(delay, options.signal);
  }
}

/** 成功（ok / empty_but_ok）以外を IntegrationError にして返す。 */
export function requireSuccess<T>(result: FetchJsonResult<T>, what: string): FetchJsonResult<T> {
  if (!isSuccessClass(result.failureClass)) {
    throw new IntegrationError(
      result.failureClass,
      `${what}: ${result.failureClass}${result.status ? ` (HTTP ${result.status})` : ""}`,
    );
  }
  return result;
}
