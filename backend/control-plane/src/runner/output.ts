// エージェントの最終出力から SUMMARY: と TARGET_IDS: を取り出す（固定シート 6 節）。
//   1 行目: SUMMARY: <個人情報を含まない 1 文>
//   途中:   CREATED: <種類>=<ID>（改善ループの作用のジョブの結果。Ruling 3。例 CREATED: article=abc123・CREATED: files=a.ts,b.ts）
//   末尾:   TARGET_IDS: <カンマ区切り>
// E-15 に残るのは SUMMARY の 1 行だけなので、CREATED: の行は `created:<種類>=<ID>` の形で targetIds に入れる
// （files はファイルごとに `created:file=<パス>`）。cycle-collect がこれを読んで項目の中身を埋める。
const SUMMARY_LINE = /^SUMMARY:\s*(.+)$/;
const TARGET_IDS_LINE = /^TARGET_IDS:\s*(.*)$/;
const CREATED_LINE = /^CREATED:\s*([a-z]+)=(.+)$/;

/** ID として許す文字。メールアドレス（@）や空白を含むものは落とす（人は ID で指す規則の最後の砦）。 */
const ID_PATTERN = /^[A-Za-z0-9:_\-./=#]{1,200}$/;
const MAX_TARGET_IDS = 200;
/** CREATED: の行の数の上限（files の分を含む） */
const MAX_CREATED = 50;

/** targetIds に入れる CREATED: の印の接頭辞 */
export const CREATED_PREFIX = "created:";

export interface AgentOutput {
  summary: string | null;
  targetIds: string[];
}

/** CREATED: の行を targetIds の印にする。files はカンマで分けて 1 ファイル 1 つ（file=）にする */
function createdMarks(lines: string[]): string[] {
  const marks: string[] = [];
  for (const line of lines) {
    const match = CREATED_LINE.exec(line);
    if (!match) continue;
    const kind = match[1]!;
    const values = kind === "files" ? match[2]!.split(",") : [match[2]!];
    for (const value of values) {
      const mark = `${CREATED_PREFIX}${kind === "files" ? "file" : kind}=${value.trim()}`;
      if (ID_PATTERN.test(mark)) marks.push(mark);
    }
  }
  return marks.slice(0, MAX_CREATED);
}

export function parseAgentOutput(text: string | null | undefined): AgentOutput {
  const lines = (text ?? "").split(/\r?\n/).map((line) => line.trim());
  const summary = lines.map((line) => SUMMARY_LINE.exec(line)?.[1]).find((value) => value !== undefined) ?? null;
  const idsLine = [...lines].reverse().map((line) => TARGET_IDS_LINE.exec(line)?.[1]).find((v) => v !== undefined);
  const targetIds = (idsLine ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => ID_PATTERN.test(id));
  // CREATED: の印を先に置く（上限で切るときに落とさない）
  return {
    summary: summary?.trim() || null,
    targetIds: [...new Set([...createdMarks(lines), ...targetIds])].slice(0, MAX_TARGET_IDS),
  };
}
