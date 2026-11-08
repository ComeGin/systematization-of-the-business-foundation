// 設定の状況: 止まったときの案内。承認済み main の setup/manual-steps.md の 0 節（早見表）を読み、止まる id ごとに
// 「いつ止まるか・何をするか・節」の行を引けるようにする。画面は項目の stopId でこれを引いて出す。
// 早見表の正本は manual-steps.md のまま（ここは読むだけ）。カタログの stopId が早見表にあることは setup/status/verify-steps.mjs が確かめる。
import type { SetupStopGuide } from "../contract.js";
import { readDocSection } from "./docs.js";

export const STOP_TABLE_FILE = "setup/manual-steps.md";
export const STOP_TABLE_HEADING = "0. 早見表";

/**
 * 早見表の 1 列目から止まる id を取り出す。最初の「（」より前の `…` だけを見て、`:` の無いもの（`build` など）は
 * 直前の id のモジュールを補う（`next-js-prod:checkout`／`build` → next-js-prod:build）。
 * setup/status/verify-steps.mjs の stopIdsInCell と同じ規則（ずれると、検査を通った id が画面で引けなくなる）。
 */
export function stopIdsInCell(cell: string): string[] {
  const head = cell.split("（")[0] ?? "";
  const ids: string[] = [];
  let module: string | null = null;
  for (const m of head.matchAll(/`([^`]+)`/g)) {
    const token = m[1]!.trim();
    if (!/^[a-z0-9-]+(:[a-z0-9-]+)?$/.test(token)) continue;
    if (token.includes(":")) {
      module = token.split(":")[0]!;
      ids.push(token);
    } else if (module) {
      ids.push(`${module}:${token}`);
    }
  }
  return ids;
}

/**
 * Markdown のリンクを文字にする（画面はリポジトリ内の相対パスをリンクにしないため）。
 * 同じファイルの中の節（`#…`）で文字が数字から始まるものは「manual 2」のように、どのファイルの節かを足す。
 */
export function unlink(markdown: string): string {
  return markdown.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_all, label: string, href: string) =>
    href.startsWith("#") && /^\d/.test(label) ? `manual ${label}` : label,
  );
}

/** 早見表の節の Markdown から、止まる id → 行 を作る。同じ id が 2 行にあれば先の行を使う。 */
export function parseStopTable(markdown: string): Record<string, SetupStopGuide> {
  const guides: Record<string, SetupStopGuide> = {};
  let separatorSeen = false;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|?\s*$/.test(line)) {
      separatorSeen = true;
      continue;
    }
    // 区切り行より前は見出し行
    if (!separatorSeen) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const [ids, when, what, section] = cells as [string, string, string, string];
    const guide: SetupStopGuide = { ids: unlink(ids), when: unlink(when), what: unlink(what), section: unlink(section) };
    for (const id of stopIdsInCell(ids)) guides[id] ??= guide;
  }
  return guides;
}

/** 承認済み main のチェックアウトの早見表を読む。読めなければ理由を返す（値は含まない）。 */
export async function readStopGuides(
  mainCheckout: string,
): Promise<{ guides: Record<string, SetupStopGuide>; error: string | null }> {
  const section = await readDocSection(mainCheckout, STOP_TABLE_FILE, STOP_TABLE_HEADING, [STOP_TABLE_FILE]);
  if (!section) return { guides: {}, error: `${STOP_TABLE_FILE} の「${STOP_TABLE_HEADING}」を承認済み main のチェックアウトで読めない` };
  return { guides: parseStopTable(section.markdown), error: null };
}
