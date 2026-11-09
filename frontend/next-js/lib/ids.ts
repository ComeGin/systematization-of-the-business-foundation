// URL から受け取る ID の形の検査（ページと Route Handler で共通）。
import type { RunOutcome } from "control-plane";

/** 改善ループの周の ID（C-YYYY-MM-DD。control-plane の CYCLE_ID_PATTERN の写し。Client Component からも読まれうるので import しない） */
export const CYCLE_ID = /^C-\d{4}-\d{2}-\d{2}$/;

/** E-15 の run_id（ULID。26 文字、Crockford Base32）。 */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Agent の名前（.claude/agents/<name>.md）。control-plane の AGENT_NAME_PATTERN の写し。
 * ここは Client Component からも読まれうるので control-plane を import しない。ずれは tests/lib/ids.test.ts が見る
 */
export const AGENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const RUN_OUTCOMES: readonly RunOutcome[] = ["success", "failure", "partial", "skipped"];

export function isRunOutcome(value: unknown): value is RunOutcome {
  return typeof value === "string" && (RUN_OUTCOMES as readonly string[]).includes(value);
}
