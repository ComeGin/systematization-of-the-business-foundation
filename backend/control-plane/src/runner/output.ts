// エージェントの最終出力から SUMMARY: と TARGET_IDS: を取り出す（固定シート 6 節）。
//   1 行目: SUMMARY: <個人情報を含まない 1 文>
//   末尾:   TARGET_IDS: <カンマ区切り>
const SUMMARY_LINE = /^SUMMARY:\s*(.+)$/;
const TARGET_IDS_LINE = /^TARGET_IDS:\s*(.*)$/;

/** ID として許す文字。メールアドレス（@）や空白を含むものは落とす（人は ID で指す規則の最後の砦）。 */
const ID_PATTERN = /^[A-Za-z0-9:_\-./=#]{1,200}$/;
const MAX_TARGET_IDS = 200;

export interface AgentOutput {
  summary: string | null;
  targetIds: string[];
}

export function parseAgentOutput(text: string | null | undefined): AgentOutput {
  const lines = (text ?? "").split(/\r?\n/).map((line) => line.trim());
  const summary = lines.map((line) => SUMMARY_LINE.exec(line)?.[1]).find((value) => value !== undefined) ?? null;
  const idsLine = [...lines].reverse().map((line) => TARGET_IDS_LINE.exec(line)?.[1]).find((v) => v !== undefined);
  const targetIds = (idsLine ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => ID_PATTERN.test(id));
  return { summary: summary?.trim() || null, targetIds: [...new Set(targetIds)].slice(0, MAX_TARGET_IDS) };
}
