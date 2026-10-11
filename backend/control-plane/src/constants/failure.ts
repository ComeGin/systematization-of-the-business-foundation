// 失敗分類 9 値と判定順（DD-01 の 4.2・4.4）
import type { FailureClass } from "../contract.js";

export const FAILURE_CLASSES = [
  "ok",
  "empty_but_ok",
  "timeout",
  "unreachable",
  "auth_failed",
  "permission_denied",
  "rate_limited",
  "truncated",
  "invalid_response",
] as const satisfies readonly FailureClass[];

/** 取得として成功した分類。E-13 の evidence に使える（DD-01 の 4.3）。 */
export function isSuccessClass(failureClass: FailureClass): boolean {
  return failureClass === "ok" || failureClass === "empty_but_ok";
}

/** 401 の意味が上流ごとに違うため、判定に上流を渡す（DD-01 の 5.3）。 */
export type Upstream = "chatwoot" | "mautic" | "github" | "gsc" | "dataforseo" | "aws" | "other";

export interface ClassifyInput {
  upstream: Upstream;
  /** 接続自体が確立しなかった（DNS・TCP） */
  connectFailed?: boolean;
  /** こちらのタイムアウトで切った */
  timedOut?: boolean;
  /** HTTP ステータス（応答があった場合） */
  status?: number;
  /** 応答に truncation_message があった */
  truncated?: boolean;
  /** 応答を解釈できた（JSON として読めた、想定の形だった） */
  parseable?: boolean;
  /** 解釈できた応答の件数 */
  count?: number;
}

/** DD-01 の 4.4 の判定順（上から順に当てはめる。順序を変えると invalid_response にすべてが吸い込まれる）。 */
export function classifyResponse(input: ClassifyInput): FailureClass {
  if (input.connectFailed) return "unreachable";
  if (input.timedOut) return "timeout";
  if (input.status === 429) return "rate_limited";
  if (input.status === 403) return "permission_denied";
  if (input.status === 401) {
    // Chatwoot は「トークン不正」と「権限不足」を区別できないため、通らない側に倒す（5.3）
    return input.upstream === "chatwoot" ? "permission_denied" : "auth_failed";
  }
  if (input.truncated) return "truncated";
  if (input.status !== undefined && (input.status < 200 || input.status >= 300)) return "invalid_response";
  if (input.parseable === false) return "invalid_response";
  if (input.count === 0) return "empty_but_ok";
  return "ok";
}
