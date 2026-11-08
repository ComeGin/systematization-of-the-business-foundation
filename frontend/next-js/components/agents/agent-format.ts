import type { AgentToolGroup, ToolAccess } from "control-plane";

const OPEN = new Set(["（", "(", "〈", "「", "『", "【", "［", "["]);
const CLOSE = new Set(["）", ")", "〉", "」", "』", "】", "］", "]"]);

/** 説明の先頭の一文（括弧の外の最初の「。」まで）。括弧の外に「。」が無ければ全文 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (OPEN.has(char)) depth++;
    else if (CLOSE.has(char)) depth = Math.max(0, depth - 1);
    else if (char === "。" && depth === 0) return trimmed.slice(0, i + 1);
  }
  return trimmed;
}

export const TOOL_ACCESS_LABEL: Record<ToolAccess, string> = { read: "参照", write: "書き込み", unknown: "不明" };

/** ツールの印の文言。組み込みの書き込み（Write・Edit）は作業ツリーの中だけに閉じ込められている（設計 7 節） */
export function toolAccessLabel(server: string | null, access: ToolAccess): string {
  if (server === null && access === "write") return "ファイルへの書き込み（作業ツリーの中だけ）";
  return TOOL_ACCESS_LABEL[access];
}

/** 接続先の表示名（null は組み込みのツール） */
export function serverLabel(group: Pick<AgentToolGroup, "server">): string {
  return group.server ?? "組み込みのツール";
}

/** ツールの完全名から、接続先の部分（mcp__<server>__）を外した短い名前 */
export function shortToolName(name: string): string {
  return name.replace(/^mcp__[a-z][a-z0-9-]*__/, "");
}
