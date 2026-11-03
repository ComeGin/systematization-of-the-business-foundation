// 手順書（Markdown）の 1 節を読み出す。カタログの docs（file, heading）を画面に出すために使う。
// 見出しの一致の規則は setup/status/verify-steps.mjs と同じ（ずれると、検査を通った見出しが画面で引けなくなる）:
//   - heading は見出しの文字列（# を除く）の先頭に一致する
//   - heading の末尾が数字なら、その後ろに数字（`4.1` に `4.10`）や `.数字`（`4.5` に `4.5.1`）が続く見出しには当たらない
//   - コードブロック（``` ・ ~~~）の中の行は見出しとみなさない
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SetupDocSection } from "../contract.js";

interface HeadingLine {
  /** 0 始まりの行の位置 */
  index: number;
  /** # の数 */
  level: number;
  /** # を除いた文字列 */
  text: string;
}

/** コードブロックの外の見出しの行を順に返す（verify-steps.mjs の linesOutsideFences・headingsOf と同じ判定） */
function findHeadings(lines: readonly string[]): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ index, level: m[1]!.length, text: m[2]! });
  });
  return out;
}

/** verify-steps.mjs の headingMatches と同じ */
function headingMatches(headingText: string, prefix: string): boolean {
  if (!headingText.startsWith(prefix)) return false;
  if (/[0-9]$/.test(prefix)) {
    const rest = headingText.slice(prefix.length);
    if (/^(\d|\.\d)/.test(rest)) return false;
  }
  return true;
}

/** 許可リストにあり、リポジトリの外を指さない相対パスか（`..`・絶対パス・NUL を拒む） */
function isSafeRelativePath(file: string): boolean {
  if (file === "" || file.includes("\0") || isAbsolute(file) || file.includes("\\")) return false;
  return !file.split("/").some((part) => part === ".." || part === "" || part === ".");
}

/**
 * mainCheckout の file のうち、heading（先頭一致）の見出しから、次の「同じか浅い」見出しの直前までを返す。
 * 次を返さずに null にする場合: file が許可リスト（allowedFiles。カタログの docs に現れるもの）に無い／危険なパス／
 * ファイルが無い／見出しが無い／先頭一致する見出しが 2 つ以上ある（どちらの節か決められない。verify-steps.mjs が通していれば起きない）。
 * 返す heading は、一致した見出しの実際の文字列（# を除く）。
 */
export async function readDocSection(
  mainCheckout: string,
  file: string,
  heading: string,
  allowedFiles: Iterable<string>,
): Promise<SetupDocSection | null> {
  if (heading.trim() === "" || !isSafeRelativePath(file)) return null;
  if (![...allowedFiles].includes(file)) return null;

  let text: string;
  try {
    // シンボリックリンクでチェックアウトの外に出ないことを、解決した実パスで確かめる
    const [root, real] = await Promise.all([realpath(mainCheckout), realpath(join(mainCheckout, file))]);
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) return null;
    text = await readFile(real, "utf8");
  } catch {
    return null;
  }

  const lines = text.split("\n");
  const headings = findHeadings(lines);
  const hits = headings.filter((h) => headingMatches(h.text, heading));
  if (hits.length !== 1) return null;
  const start = hits[0]!;

  const next = headings.find((h) => h.index > start.index && h.level <= start.level);
  const end = next ? next.index : lines.length;
  const markdown = lines
    .slice(start.index, end)
    .join("\n")
    .replace(/\s+$/, "");
  return { file, heading: start.text, markdown };
}
