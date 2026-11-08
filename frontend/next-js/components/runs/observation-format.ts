// 実行の「中身」（その実行が書いた観測の取得の結果）の判定。読んだだけの観測（referenced）は数えない
// （設計 docs/superpowers/specs/2026-11-06-job-agent-info-design.md の 6 節）。
import type { RunObservations } from "control-plane";
import { describeOutcome } from "@/components/common/failure-class";

export type ContentSummary = { kind: "none" } | { kind: "ok"; total: number } | { kind: "failed"; failed: number; total: number };

export function summarizeContent(observations: RunObservations | undefined): ContentSummary {
  const written = observations?.written ?? [];
  if (written.length === 0) return { kind: "none" };
  const failed = written.filter((observation) => !describeOutcome(observation.outcome).ok).length;
  return failed === 0 ? { kind: "ok", total: written.length } : { kind: "failed", failed, total: written.length };
}
