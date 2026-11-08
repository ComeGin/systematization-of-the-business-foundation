// 観測（E-12。docs/audits/<source>/<audit_id>.md）の索引。監視アプリが「その実行が書いた観測」と「対象にした観測」を出すために読む
// （設計 docs/superpowers/specs/2026-11-06-job-agent-info-design.md の 6 節）。
// 読むのは frontmatter だけ（本文は読まない）。作業ツリー → 承認済み main の順に読み、同じ audit_id は作業ツリーを優先する。
// 「書いた観測」は fetch.correlation_id が実行の runId と一致するもの。targetIds はエージェントが自分で書く値で当てにならない
// （2026-11-06 の daily-observe-ops は観測を書いたのに targetIds が []）。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AUDITS_DIR } from "../constants/paths.js";
import { logLine } from "../log.js";
import { redactPii } from "../pii.js";
import type { ObservationSummary, RunObservations, RunRecord } from "../contract.js";

/** 観測の ID の形。これに合わない値（E-05・LH-seo・ULID・パスを抜けるもの）はファイルを開かない */
export const AUDIT_ID_PATTERN = /^AUD-\d{4}-\d{4}-[a-z_]+-\d{4}$/;

export interface AuditIndex {
  byId: Map<string, ObservationSummary>;
  byCorrelation: Map<string, ObservationSummary[]>;
}

interface IndexedObservation {
  summary: ObservationSummary;
  correlationId: string | null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
/** frontmatter を YAML として読めないときに、correlation_id の行だけを拾う（中身の失敗を「書いた観測が無い」に隠さないため） */
const CORRELATION_LINE = /^\s*correlation_id:\s*['"]?([0-9A-HJKMNP-TV-Z]{26})['"]?\s*$/m;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** 観測の理由。エージェントが書いた文なので、画面に出す前にメールアドレスと電話番号を伏せる（2026-11-09） */
function noteOf(value: unknown): string | null {
  const note = text(value);
  return note === null ? null : redactPii(note).text;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 1 つのファイルの frontmatter。読めない・形が違うときも found: true で返す（中身の失敗として数えるため） */
function summarize(auditId: string, directory: string, content: string): IndexedObservation {
  let front: Record<string, unknown> | null = null;
  const match = FRONTMATTER.exec(content);
  if (match) {
    try {
      front = record(parseYaml(match[1] ?? ""));
    } catch {
      front = null;
    }
  }
  const fetch = record(front?.fetch);
  const correlationId = text(fetch?.correlation_id) ?? (front === null && match ? (CORRELATION_LINE.exec(match[1] ?? "")?.[1] ?? null) : null);
  return {
    summary: {
      auditId,
      source: text(front?.source) ?? directory,
      createdBy: text(front?.created_by),
      outcome: text(fetch?.outcome),
      note: noteOf(fetch?.note),
      measuredAt: text(fetch?.measured_at),
      found: true,
    },
    correlationId,
  };
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** audit_id の日付の部分（AUD-<西暦>-<月日>-… の「<西暦>-<月日>」） */
function auditDateOf(auditId: string): string {
  return auditId.slice(4, 13);
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function jstAuditDate(ms: number): string {
  const iso = new Date(ms + JST_OFFSET_MS).toISOString(); // YYYY-MM-DDT…（JST の日付）
  return `${iso.slice(0, 4)}-${iso.slice(5, 7)}${iso.slice(8, 10)}`;
}

/**
 * 実行の観測を探すときに読む日付（audit_id の「<西暦>-<月日>」）。実行の開始日（JST）とその翌日（0 時をまたぐ実行のため）と、
 * targetIds の観測の日付。audit_id の日付は作成日（JST。docs/audits/README.md）なので、ほかの日付のファイルは読まずに済む
 * （全件を読むと 1 年分で数秒かかる。2026-11-06 の最終レビュー）
 */
export function auditDatesForRuns(runs: Pick<RunRecord, "startedAt" | "targetIds">[]): Set<string> {
  const dates = new Set<string>();
  for (const run of runs) {
    const started = Date.parse(run.startedAt);
    if (Number.isFinite(started)) {
      dates.add(jstAuditDate(started));
      dates.add(jstAuditDate(started + DAY_MS));
    }
    for (const id of run.targetIds) if (AUDIT_ID_PATTERN.test(id)) dates.add(auditDateOf(id));
  }
  return dates;
}

async function readRoot(root: string, dates: Set<string> | null): Promise<Map<string, IndexedObservation>> {
  const result = new Map<string, IndexedObservation>();
  const base = join(root, AUDITS_DIR);
  for (const directory of (await listDirectories(base)).sort()) {
    const names = (await readdir(join(base, directory))).filter((name) => name.endsWith(".md")).sort();
    for (const name of names) {
      const auditId = name.slice(0, -".md".length);
      if (!AUDIT_ID_PATTERN.test(auditId)) continue; // README.md・_template.md・メモ
      if (dates && !dates.has(auditDateOf(auditId))) continue;
      let content: string;
      try {
        content = await readFile(join(base, directory, name), "utf8");
      } catch (error) {
        // 1 つのファイルを読めないだけで画面ごと落とさない。中身の失敗として数える（found: true・outcome: null。2026-11-09）
        logLine("WARN", "audits", `${directory}/${name} を読めない（${(error as NodeJS.ErrnoException).code ?? "不明"}）`);
        content = "";
      }
      result.set(auditId, summarize(auditId, directory, content));
    }
  }
  return result;
}

/**
 * 作業ツリーと main の docs/audits/*\/ を読んで索引を作る。キャッシュは持たない（呼ぶたびに読む）。
 * options.dates を渡すと、その日付（auditDatesForRuns）の観測だけを読む
 */
export async function loadAuditIndex(
  roots: { worktree: string; mainCheckout: string },
  options: { dates?: Set<string> } = {},
): Promise<AuditIndex> {
  const dates = options.dates ?? null;
  const merged = await readRoot(roots.mainCheckout, dates);
  for (const [auditId, observation] of await readRoot(roots.worktree, dates)) merged.set(auditId, observation); // 作業ツリーを優先

  const byId = new Map<string, ObservationSummary>();
  const byCorrelation = new Map<string, ObservationSummary[]>();
  for (const auditId of [...merged.keys()].sort()) {
    const { summary, correlationId } = merged.get(auditId)!;
    byId.set(auditId, summary);
    if (correlationId) byCorrelation.set(correlationId, [...(byCorrelation.get(correlationId) ?? []), summary]);
  }
  return { byId, byCorrelation };
}

function missing(auditId: string): ObservationSummary {
  return { auditId, source: null, createdBy: null, outcome: null, note: null, measuredAt: null, found: false };
}

/** 書いた観測（correlation_id が一致）と、対象にした観測（targetIds にあり、書いた観測でないもの） */
export function observationsForRun(run: Pick<RunRecord, "runId" | "targetIds">, index: AuditIndex): RunObservations {
  const written = index.byCorrelation.get(run.runId) ?? [];
  const writtenIds = new Set(written.map((observation) => observation.auditId));
  const referenced: ObservationSummary[] = [];
  for (const id of new Set(run.targetIds)) {
    if (!AUDIT_ID_PATTERN.test(id) || writtenIds.has(id)) continue;
    referenced.push(index.byId.get(id) ?? missing(id));
  }
  return { runId: run.runId, written: [...written], referenced };
}
