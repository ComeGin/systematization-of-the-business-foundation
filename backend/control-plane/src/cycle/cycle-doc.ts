// 周の項目と差し戻しの理由の書き出し（作業ツリーの docs/cycles/<周 ID>.md。spec 5.3）。
// 次の周の proposal-writer と作用のジョブが読み、同じ案を繰り返さないために使う。個人情報を含まない要約だけを書く
// （題・理由は redactSummary を通す。本文・メールの中身・送信先は書かない）。中身が変わらなければ書き直さない。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CYCLES_DOC_DIR } from "../constants/paths.js";
import type { CycleItem, CycleItemKind, CycleItemState, CycleRow } from "../contract.js";
import { redactSummary } from "../pii.js";
import type { CycleStore } from "../store/cycles.js";

/** システム（定期実行のジョブ）が行った状態の変更の actor（cycle_approvals に残る）。人の差し戻しと区別する */
export const SYSTEM_ACTOR = "system";

/**
 * システムが置き換えとして差し戻した項目（配信の項目の置き換え。最後の差し戻しの記録の actor が SYSTEM_ACTOR）を除く。
 * 次の周のエージェントに渡す差し戻しの節に、人の判断ではない置き換えの理由が雑音として載らないようにする（P4）
 */
export function withoutSystemRejections(cycles: Pick<CycleStore, "listApprovals">, items: readonly CycleItem[]): CycleItem[] {
  return items.filter((item) => {
    if (item.state !== "rejected") return true;
    const last = cycles.listApprovals(item.itemId).filter((approval) => approval.action === "reject").at(-1);
    return last?.actor !== SYSTEM_ACTOR;
  });
}

const KIND_LABEL: Record<CycleItemKind, string> = {
  article: "記事",
  campaign: "キャンペーン",
  code: "コード",
  deploy: "配信",
  proposal: "改修案",
  manual: "手作業",
};

const STATE_LABEL: Record<CycleItemState, string> = {
  preparing: "準備中",
  awaiting_review: "OK 待ち",
  approved: "OK 済み（未実行）",
  executed: "実行済み（確認待ち）",
  confirmed: "確かめた",
  rejected: "差し戻し",
  failed_check: "確かめられなかった",
};

/** 表のセルに入れる文字（| と改行を崩さない） */
function cell(text: string): string {
  return redactSummary(text).text.replace(/\|/g, "\\|");
}

/**
 * items は「この周に作られた項目」の表に、updatedInCycle は「差し戻し・確かめられなかった」の節に使う。
 * 項目の cycleId は最初の周のまま変わらないので、周をまたいで差し戻された項目は updatedInCycle（updatedAt がこの周の期間）で拾う
 */
export function renderCycleDoc(cycle: CycleRow, items: readonly CycleItem[], updatedInCycle: readonly CycleItem[]): string {
  const own = items.filter((item) => item.cycleId === cycle.cycleId);
  const lines = [
    `# 改善ループの周 ${cycle.cycleId}`,
    "",
    `- 期間: ${cycle.startsAt.slice(0, 10)} から 14 日（JST。終わりは ${cycle.endsAt.slice(0, 10)} の 0 時）`,
    "- 監視アプリの cycle-collect が書き出す（手で直さない。次の実行で書き直される）。個人情報を含まない要約だけを書く",
    "- 次の周の proposal-writer と作用のジョブは、差し戻しの理由を読んで同じ案を繰り返さない",
    "",
    "## 項目",
    "",
  ];
  if (own.length === 0) {
    lines.push("この周に作られた項目は無い。");
  } else {
    lines.push("| 種類 | 改修案 | 題 | 状態 | 反映 |", "|---|---|---|---|---|");
    for (const item of own) {
      lines.push(
        `| ${KIND_LABEL[item.kind]} | ${item.proposalId ?? "—"} | ${cell(item.title)} | ${STATE_LABEL[item.state]} | ${item.reflectedAt ? item.reflectedAt.slice(0, 10) : "—"} |`,
      );
    }
  }
  const rejected = updatedInCycle.filter((item) => item.state === "rejected" || item.state === "failed_check");
  lines.push("", "## 差し戻しと確かめられなかった理由", "");
  if (rejected.length === 0) {
    lines.push("無し。");
  } else {
    for (const item of rejected) {
      const reason = item.stateReason ? redactSummary(item.stateReason).text : "（理由の記録なし）";
      const origin = item.cycleId === cycle.cycleId ? "" : `・${item.cycleId} に作成`;
      lines.push(`- ${item.proposalId ?? KIND_LABEL[item.kind]}（${KIND_LABEL[item.kind]}・${STATE_LABEL[item.state]}${origin}）: ${reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** docs/cycles/<周 ID>.md を書く。中身が同じなら書かない。書いたら true */
export async function writeCycleDoc(
  worktree: string,
  cycle: CycleRow,
  items: readonly CycleItem[],
  updatedInCycle: readonly CycleItem[],
): Promise<boolean> {
  const dir = join(worktree, CYCLES_DOC_DIR);
  const file = join(dir, `${cycle.cycleId}.md`);
  const text = renderCycleDoc(cycle, items, updatedInCycle);
  try {
    if ((await readFile(file, "utf8")) === text) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(file, text, "utf8");
  return true;
}
