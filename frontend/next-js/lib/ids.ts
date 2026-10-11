// URL から受け取る ID の形の検査（ページと Route Handler で共通）。
import type { RunOutcome } from "control-plane";

/** E-15 の run_id（ULID。26 文字、Crockford Base32）。 */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const RUN_OUTCOMES: readonly RunOutcome[] = ["success", "failure", "partial", "skipped"];

export function isRunOutcome(value: unknown): value is RunOutcome {
  return typeof value === "string" && (RUN_OUTCOMES as readonly string[]).includes(value);
}
