#!/usr/bin/env node
// 手順の一覧（setup/status/steps.mjs）と setup/00-setup-overview.md のずれの検査。
//
//   node setup/status/verify-steps.mjs [--root <dir>]
//
// 終了コード: 0 一致／1 不一致（理由を 1 行ずつ標準エラーに出す）。--root の既定はリポジトリのルート。
// 読み取りだけで、何も書かない。依存なし。
//
// 確かめること:
//   (a) 3 節の各 P の見出し（`### P<n>.`）が STEPS にあり、逆も同じ。6 節（`## 6.`）が R1 にある
//   (b) 各項目の overviewText が、その段階の節に 1 回だけ現れ、チェック項目の行（R1 は表の行）の中にある
//   (c) その段階のチェック項目の行の数と項目の数が同じで、1 行に 1 項目が対応し、順番も同じ
//   (d) docs の各ファイルが root にあり、heading に先頭一致する見出しが 1 つだけある
//   (e) probe が item のとき key、items のとき keys の 1 つ 1 つについて、(key, 段階) が KNOWN_ITEM_KEYS にある（items の keys は空にしない）
//   (f) `### P<n>.` の見出しが重複していない
//
// チェック項目の行 = 節の中の、字下げのない次のどれか（コードブロックの中は数えない）:
//   `- [ ] ` / `- [x] `、`- 〔`（〔未検査〕〔警告〕〔申告〕）、`- 再実行で **自動**`
// 字下げのない `- ` の行でも上のどれにも当たらないものは数えず、「注意:」として標準エラーに出す（新しい手順を `[ ]` なしで書いたときに気づくため。失敗にはしない）
// R1 の行 = 6 節の最初の表（`###` の前まで）の、見出し行と区切り行を除いた行

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as defaultCatalog from "./steps.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OVERVIEW = "setup/00-setup-overview.md";

const WHO = ["自動", "人・端末", "人・画面", "人・GitHub", "人・ブラウザ", "判断"];
const KIND = ["検査", "警告", "申告", "未検査", "判断"];
const DRIFT_IDS = ["site-redeploy", "n8n-workflows"];

const CHECKLIST_LINE = /^- (\[[ xX]\] |〔|再実行で \*\*自動\*\*)/;

/** コードブロックの外の行だけを { n, text } で返す（n は 1 始まり） */
function linesOutsideFences(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (!fence) out.push({ n: i + 1, text: line });
  });
  return out;
}

/** 見出しの文字列（# を除く）の一覧。コードブロックの中の # は見出しではない */
function headingsOf(text) {
  const out = [];
  for (const { text: line } of linesOutsideFences(text)) {
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** heading が見出しの先頭に一致するか。heading の末尾が数字なら、その後ろに数字が続く見出しには当たらない */
function headingMatches(headingText, prefix) {
  if (!headingText.startsWith(prefix)) return false;
  if (/[0-9]$/.test(prefix)) {
    const rest = headingText.slice(prefix.length);
    if (/^(\d|\.\d)/.test(rest)) return false;
  }
  return true;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** 00-setup-overview.md を、段階ごとの節（チェック項目の行・節の全文）に分ける */
function parseOverview(text) {
  const lines = linesOutsideFences(text);
  const sections = new Map(); // id -> { rows: string[], body: string }
  const duplicates = [];
  const stray = []; // { id, line }
  let current = null;
  const close = () => {
    if (!current) return;
    current.body = current.lines.join("\n");
    if (sections.has(current.id)) duplicates.push(current.id);
    else sections.set(current.id, current);
    current = null;
  };
  for (const { text: line } of lines) {
    const isH2or3 = /^#{2,3}\s/.test(line);
    if (isH2or3) {
      close();
      const p = /^### (P\d+)\./.exec(line);
      if (p) { current = { id: p[1], kind: "P", lines: [], rows: [] }; continue; }
      if (/^## 6\./.test(line)) { current = { id: "R1", kind: "R1", lines: [], rows: [], tableLines: [] }; continue; }
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (current.kind === "P" && CHECKLIST_LINE.test(line)) current.rows.push(line);
    else if (current.kind === "P" && line.startsWith("- ")) stray.push({ id: current.id, line });
    if (current.kind === "R1" && line.startsWith("|")) current.tableLines.push(line);
  }
  close();
  for (const s of sections.values()) {
    if (s.kind !== "R1") continue;
    // 最初の表: 見出し行・区切り行を除く
    const t = s.tableLines;
    const sep = t.findIndex((l) => /^\|[\s:|-]+\|?\s*$/.test(l));
    s.rows = sep === -1 ? [] : t.slice(sep + 1);
  }
  return { sections, duplicates, stray };
}

/**
 * @param {{ root?: string; catalog?: typeof defaultCatalog }} [options]
 * @returns {{ problems: string[]; notes: string[]; itemCount: number }}
 */
export function verifySteps({ root = DEFAULT_ROOT, catalog = defaultCatalog } = {}) {
  const problems = [];
  const notes = [];
  const { STEPS, KNOWN_ITEM_KEYS } = catalog;
  const itemCount = STEPS.reduce((n, s) => n + s.items.length, 0);

  const overviewPath = join(root, OVERVIEW);
  if (!existsSync(overviewPath)) {
    problems.push(`${OVERVIEW} が ${root} に無い`);
    return { problems, notes, itemCount };
  }
  const { sections, duplicates, stray } = parseOverview(readFileSync(overviewPath, "utf8"));
  for (const id of new Set(duplicates)) problems.push(`${id}: ${OVERVIEW} に ${id === "R1" ? "`## 6.`" : `\`### ${id}.\``} の見出しが 2 つ以上ある`);
  for (const { id, line } of stray) notes.push(`注意: ${id} に、チェック項目の形（\`- [ ] \`・\`- 〔\`・\`- 再実行で **自動**\`）ではない \`- \` の行がある（数えない）: ${line.slice(0, 50)}`);

  // (a) 見出しと STEPS の対応
  const catalogIds = STEPS.map((s) => s.id);
  for (const id of new Set(catalogIds.filter((id) => catalogIds.indexOf(id) !== catalogIds.lastIndexOf(id)))) {
    problems.push(`${id}: STEPS に同じ id の段階が 2 つある`);
  }
  for (const id of sections.keys()) {
    if (!catalogIds.includes(id)) problems.push(`${id}: ${OVERVIEW} にあるが、STEPS に無い`);
  }
  for (const id of catalogIds) {
    if (!sections.has(id)) {
      problems.push(`${id}: STEPS にあるが、${OVERVIEW} に見出し（${id === "R1" ? "`## 6.`" : `\`### ${id}.\``}）が無い`);
    }
  }

  const headingCache = new Map();
  const headingsIn = (file) => {
    if (!headingCache.has(file)) {
      const p = join(root, file);
      headingCache.set(file, existsSync(p) ? headingsOf(readFileSync(p, "utf8")) : null);
    }
    return headingCache.get(file);
  };

  const knownByKey = new Map((KNOWN_ITEM_KEYS ?? []).map((k) => [k.key, k.steps]));
  const referenced = new Set();

  for (const step of STEPS) {
    const section = sections.get(step.id);
    const seenIds = new Set();
    const lineToItem = new Map(); // 行の番号 -> item.id
    let lastLine = -1;

    for (const it of step.items) {
      const where = `${step.id} ${it.id ?? "(id なし)"}`;
      if (!it.id) problems.push(`${step.id}: id の無い項目がある（${it.title ?? it.overviewText ?? "?"}）`);
      else if (seenIds.has(it.id)) problems.push(`${where}: 段階の中で id が重複している`);
      else seenIds.add(it.id);
      if (it.id && !it.id.startsWith(`${step.id}.`)) problems.push(`${where}: id が段階 ${step.id} の "${step.id}." で始まらない`);

      // 形
      if (!WHO.includes(it.who)) problems.push(`${where}: who が不正（${String(it.who)}）`);
      if (!KIND.includes(it.kind)) problems.push(`${where}: kind が不正（${String(it.kind)}）`);
      if (typeof it.title !== "string" || it.title === "") problems.push(`${where}: title が空`);
      const probe = it.probe;
      if (!probe || typeof probe !== "object") {
        problems.push(`${where}: probe が無い`);
      } else if (probe.kind === "item" || probe.kind === "items") {
        // (e)
        const keys = probe.kind === "item" ? [probe.key] : probe.keys;
        if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== "string" || k === "")) {
          problems.push(`${where}: probe の ${probe.kind === "item" ? "key" : "keys"} が空、または文字列ではない`);
        } else {
          for (const key of keys) {
            const steps = knownByKey.get(key);
            if (!steps) problems.push(`${where}: probe の key "${key}" が KNOWN_ITEM_KEYS に無い`);
            else if (!steps.includes(step.id)) problems.push(`${where}: key "${key}" は ${steps.join("・")} に出す項目で、${step.id} には出ない（KNOWN_ITEM_KEYS）`);
            else referenced.add(`${key} (${step.id})`);
          }
        }
      } else if (probe.kind === "module") {
        if (!probe.module || !probe.phase) problems.push(`${where}: probe の module・phase が足りない`);
      } else if (probe.kind === "drift") {
        if (!DRIFT_IDS.includes(probe.id)) problems.push(`${where}: probe の drift id が不正（${String(probe.id)}）`);
      } else if (probe.kind !== "none") {
        problems.push(`${where}: probe.kind が不正（${String(probe.kind)}）`);
      }
      if (probe?.kind === "none" && ["検査", "警告"].includes(it.kind)) {
        problems.push(`${where}: kind が ${it.kind} なのに probe が none`);
      }

      // (d)
      if (!Array.isArray(it.docs)) {
        problems.push(`${where}: docs が配列ではない`);
      } else {
        for (const d of it.docs) {
          const headings = headingsIn(d.file);
          if (headings === null) { problems.push(`${where}: docs のファイル ${d.file} が無い`); continue; }
          const hits = headings.filter((h) => headingMatches(h, d.heading));
          if (hits.length === 0) problems.push(`${where}: ${d.file} に "${d.heading}" で始まる見出しが無い`);
          else if (hits.length > 1) problems.push(`${where}: ${d.file} に "${d.heading}" で始まる見出しが ${hits.length} 個ある（${hits.map((h) => `"${h.slice(0, 24)}"`).join("・")}）`);
        }
      }

      // (b)
      if (!section) continue;
      if (typeof it.overviewText !== "string" || it.overviewText === "") {
        problems.push(`${where}: overviewText が空`);
        continue;
      }
      const times = countOccurrences(section.body, it.overviewText);
      if (times === 0) { problems.push(`${where}: overviewText が ${OVERVIEW} の ${step.id} の節に無い: ${it.overviewText}`); continue; }
      if (times > 1) { problems.push(`${where}: overviewText が ${step.id} の節に ${times} 回現れる（1 回だけにする）: ${it.overviewText}`); continue; }
      const rowIndex = section.rows.findIndex((row) => row.includes(it.overviewText));
      if (rowIndex === -1) {
        problems.push(`${where}: overviewText がチェック項目の行（${step.id === "R1" ? "表の行" : "`- [ ]` などの行"}）の中に無い: ${it.overviewText}`);
        continue;
      }
      if (lineToItem.has(rowIndex)) {
        problems.push(`${where}: ${lineToItem.get(rowIndex)} と同じ行を指している: ${section.rows[rowIndex].slice(0, 40)}`);
        continue;
      }
      lineToItem.set(rowIndex, it.id);
      if (rowIndex < lastLine) problems.push(`${where}: 項目の順番が ${OVERVIEW} の行の順と違う`);
      lastLine = Math.max(lastLine, rowIndex);
    }

    // (c)
    if (!section) continue;
    if (section.rows.length !== step.items.length) {
      problems.push(`${step.id}: 項目の数が合わない（${OVERVIEW} は ${section.rows.length} 行・STEPS は ${step.items.length} 件）`);
    }
    section.rows.forEach((row, i) => {
      if (!lineToItem.has(i)) problems.push(`${step.id}: 対応する項目が無い行: ${row.slice(0, 60)}`);
    });
  }

  // 出す (key, 段階) のうち、どのカタログの項目からも引かれていないもの（注意だけ。失敗にはしない）
  for (const { key, steps } of KNOWN_ITEM_KEYS ?? []) {
    for (const s of steps) {
      if (!referenced.has(`${key} (${s})`)) notes.push(`注意: モジュールが出す ${key}（${s}）は、カタログのどの項目の probe にもなっていない`);
    }
  }
  return { problems, notes, itemCount };
}

function main(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) { console.error("--root にはディレクトリを指定する"); return 1; }
      root = resolve(v);
      i++;
    } else {
      console.error(`使い方: node setup/status/verify-steps.mjs [--root <dir>]（知らない引数: ${argv[i]}）`);
      return 1;
    }
  }
  const { problems, notes, itemCount } = verifySteps({ root });
  for (const n of notes) console.error(n);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`NG: ${problems.length} 件のずれ。${OVERVIEW} と setup/status/steps.mjs をそろえる`);
    return 1;
  }
  console.log(`OK: ${OVERVIEW} と setup/status/steps.mjs が一致している（${itemCount} 項目）`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
