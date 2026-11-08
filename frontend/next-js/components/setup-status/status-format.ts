// 設定の状況の表示に使う純粋な関数（描画しないのでテストできる）。
import type { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";
import type { SetupRunOrderEntry, SetupStatusLevel, SetupStatusStepView } from "control-plane";

/** 判定 → Cloudscape の StatusIndicator の種類と文言（● 更新が必要／! 警告／? 確かめられない／◇ 人が確かめる／✓ 済み） */
export const LEVEL_INDICATOR: Record<SetupStatusLevel, { type: StatusIndicatorProps.Type; label: string }> = {
  action: { type: "error", label: "更新が必要" },
  warn: { type: "warning", label: "警告" },
  unknown: { type: "stopped", label: "確かめられない" },
  manual: { type: "info", label: "人が確かめる" },
  ok: { type: "success", label: "済み" },
};

/** 件数の並び順（重い順） */
export const LEVEL_ORDER: readonly SetupStatusLevel[] = ["action", "warn", "unknown", "manual", "ok"];

/** 既定の選択: 更新が必要な最初の段階 → 警告 → 確かめられない → なければ先頭（P1） */
export function defaultStepId(steps: readonly Pick<SetupStatusStepView, "id" | "level">[]): string | null {
  for (const level of ["action", "warn", "unknown"] as const) {
    const found = steps.find((step) => step.level === level);
    if (found) return found.id;
  }
  return steps[0]?.id ?? null;
}

/** ?step= の値を、実在する段階の id に解決する。無い・不正・複数なら既定の選択。 */
export function resolveStepId(steps: readonly Pick<SetupStatusStepView, "id" | "level">[], requested: string | string[] | undefined): string | null {
  if (typeof requested === "string" && steps.some((step) => step.id === requested)) return requested;
  return defaultStepId(steps);
}

/** Markdown の中のリンクのうち、リンクとして出してよいもの（絶対の http(s)）。相対パスはリポジトリ内のパスなので文字として出す。 */
export function isExternalHttpUrl(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** 手順書の API の URL */
export function docUrl(file: string, heading: string): string {
  return `/api/setup-status/doc?${new URLSearchParams({ file, heading }).toString()}`;
}

/** 何も変えずに状態を見るだけのコマンド（--check） */
export function isCheckCommand(command: string | null): boolean {
  return command !== null && /(^|\s)--check(\s|$)/.test(command);
}

/**
 * 実行の順番のうち「次に行う」行の id。確かめるだけの行（--check）を除き、段階に「更新が必要」か「確かめられない」がある最初の行。
 * 無ければ null（すべて済んでいる・警告だけ・まだ確かめていない）。
 */
export function nextRunEntryId(entries: readonly Pick<SetupRunOrderEntry, "id" | "command" | "level">[]): string | null {
  const next = entries.find((entry) => !isCheckCommand(entry.command) && (entry.level === "action" || entry.level === "unknown"));
  return next?.id ?? null;
}

/** 段階の並びの短い表記。P の番号が 1 つずつ続くなら「P1〜P10」、それ以外は「・」でつなぐ。 */
export function stepRangeLabel(stepIds: readonly string[]): string {
  if (stepIds.length <= 2) return stepIds.join("・");
  const numbers = stepIds.map((id) => /^P(\d+)$/.exec(id)?.[1]).map((n) => (n === undefined ? Number.NaN : Number(n)));
  const consecutive = numbers.every((n, i) => Number.isInteger(n) && (i === 0 || n === numbers[i - 1]! + 1));
  return consecutive ? `${stepIds[0]}〜${stepIds[stepIds.length - 1]}` : stepIds.join("・");
}

/** 実行の順番の行から開く段階: その中で最初の「更新が必要」→「警告」→「確かめられない」の段階。無ければ先頭。 */
export function runEntryStepId(
  stepIds: readonly string[],
  steps: readonly Pick<SetupStatusStepView, "id" | "level">[],
): string | null {
  const inEntry = stepIds.map((id) => steps.find((step) => step.id === id)).filter((step) => step !== undefined);
  return defaultStepId(inEntry) ?? stepIds[0] ?? null;
}

/** 画面の URL（?step=） */
export function stepHref(stepId: string): string {
  return `/setup-status?${new URLSearchParams({ step: stepId }).toString()}`;
}
