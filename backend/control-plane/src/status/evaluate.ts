// 設定の状況: カタログ（手順の一覧）の各項目を、設定スクリプトの結果・ずれの確認に当てて level と根拠を決める（spec の 5.1・5.2）。
// 純粋な関数だけ（時刻は引数）。秘密値は呼び出し側（service.ts）が redact してから渡す。
import type { SetupStatusItemView, SetupStatusLevel, SetupStatusStepView, SetupStatusView } from "../contract.js";
import type { Catalog, CatalogItem } from "./catalog.js";
import type { DriftResult } from "./drift.js";
import type { SetupCheckReport, SetupScript, StatusItem } from "./run-check.js";

/** 設定スクリプトのモジュール 1 つ・段階 1 つの結果に、確かめた時刻と、どちらの親スクリプトの結果かを足したもの。 */
export type ModuleResultWithTime = SetupCheckReport["results"][number] & { checkedAt: string; script: SetupScript };

/** evaluate の戻り値（画面の形のうち、確認の結果から決まる部分） */
export type EvaluatedStatus = Omit<SetupStatusView, "enabled" | "reason" | "running" | "nextCheckAt" | "notifyError" | "guide">;

/** 重さの順（大きいほど重い）。action > warn > unknown > manual > ok（spec の 4 節） */
const SEVERITY: Record<SetupStatusLevel, number> = { action: 4, warn: 3, unknown: 2, manual: 1, ok: 0 };
const LEVELS: readonly SetupStatusLevel[] = ["ok", "action", "warn", "manual", "unknown"];

/** 根拠の長さの上限（画面とメールが読める長さ） */
const MAX_EVIDENCE = 600;
const SEPARATOR = "／";

const clip = (text: string) => (text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text);

/** 最も重い level。空なら ok。 */
export function worstLevel(levels: readonly SetupStatusLevel[]): SetupStatusLevel {
  let worst: SetupStatusLevel = "ok";
  for (const level of levels) if (SEVERITY[level] > SEVERITY[worst]) worst = level;
  return worst;
}

export function zeroCounts(): Record<SetupStatusLevel, number> {
  return Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<SetupStatusLevel, number>;
}

/**
 * 2 本の親スクリプトの結果を 1 つにする。`(moduleId, phase)` が同じものは先に渡した一覧のほうを使う
 * （ga4・next-js-prod は setup.mjs と frontend.mjs の両方に出る。setup.mjs を先に渡す）。
 */
export function mergeModuleResults(...lists: readonly (readonly ModuleResultWithTime[])[]): ModuleResultWithTime[] {
  const seen = new Set<string>();
  const out: ModuleResultWithTime[] = [];
  for (const list of lists) {
    for (const result of list) {
      const key = `${result.moduleId}\u0000${result.phase ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(result);
    }
  }
  return out;
}

interface Judged {
  level: SetupStatusLevel;
  evidence: string;
  checkedAt: string | null;
  stopId?: string;
}

interface Context {
  results: readonly ModuleResultWithTime[];
  drifts: readonly DriftResult[];
  fetchError: string | null;
  checkedAt: string;
  /** 結果が無いときの根拠に添える、親スクリプトそのものの失敗（例「setup/setup.mjs の確認が 300 秒で終わらなかった」） */
  runErrors: readonly string[];
}

const SKIPPED_EVIDENCE = "まだ確かめていない（製品の API を呼ぶ確認は 1 時間に 1 回）";

function missingResult(ctx: Context): string {
  const base = "モジュールの結果が無い";
  return ctx.runErrors.length > 0 ? `${base}（${ctx.runErrors.join(SEPARATOR)}）` : base;
}

/** モジュールの結果から、key と step が一致する項目を探す。 */
function judgeKey(ctx: Context, key: string, stepId: string): Judged {
  const hits: { item: StatusItem; result: ModuleResultWithTime }[] = [];
  for (const result of ctx.results) {
    for (const item of result.items) if (item.key === key && item.step === stepId) hits.push({ item, result });
  }
  if (hits.length > 0) {
    // 複数の段階の結果に同じ項目が出たら、重いほうを使う
    const pick = hits.reduce((a, b) => (SEVERITY[b.item.level] > SEVERITY[a.item.level] ? b : a));
    return {
      level: pick.item.level,
      evidence: pick.item.evidence,
      checkedAt: pick.result.checkedAt,
      ...(pick.item.stopId ? { stopId: pick.item.stopId } : {}),
    };
  }

  // 項目が無い理由を、key の先頭（モジュールの id）の結果から探す
  const moduleId = key.split(".")[0] ?? key;
  const own = ctx.results.filter((result) => result.moduleId === moduleId);
  const failed = own.find((result) => result.error !== null);
  if (failed) return { level: "unknown", evidence: `確かめられなかった: ${failed.error}`, checkedAt: failed.checkedAt };
  if (own.length > 0 && own.every((result) => result.skipped)) return { level: "unknown", evidence: SKIPPED_EVIDENCE, checkedAt: null };
  if (own.length === 0) return { level: "unknown", evidence: missingResult(ctx), checkedAt: null };
  return { level: "unknown", evidence: "モジュールが項目を返さなかった", checkedAt: own[0]!.checkedAt };
}

function judgeModule(ctx: Context, moduleId: string, phase: string): Judged {
  const result = ctx.results.find((r) => r.moduleId === moduleId && r.phase === phase);
  if (!result) return { level: "unknown", evidence: missingResult(ctx), checkedAt: null };
  if (result.skipped) return { level: "unknown", evidence: SKIPPED_EVIDENCE, checkedAt: null };
  if (result.error !== null) return { level: "unknown", evidence: `確かめられなかった: ${result.error}`, checkedAt: result.checkedAt };
  const notes = result.notes.join(SEPARATOR);
  if (!result.ok) return { level: "action", evidence: notes || "まだ用意できていない", checkedAt: result.checkedAt };
  if (result.notes.some((note) => note.startsWith("! "))) return { level: "warn", evidence: notes, checkedAt: result.checkedAt };
  return { level: "ok", evidence: notes || "用意できている", checkedAt: result.checkedAt };
}

function judgeDrift(ctx: Context, id: DriftResult["id"]): Judged {
  if (ctx.fetchError !== null) {
    return { level: "unknown", evidence: `GitHub から main の最新を取れなかった: ${ctx.fetchError}`, checkedAt: ctx.checkedAt };
  }
  const drift = ctx.drifts.find((d) => d.id === id);
  if (!drift) return { level: "unknown", evidence: "ずれの確認の結果が無い", checkedAt: null };
  return { level: drift.level, evidence: drift.evidence, checkedAt: drift.checkedAt ?? ctx.checkedAt };
}

const MANUAL_EVIDENCE: Record<CatalogItem["kind"], string> = {
  検査: "自動では確かめない（人が確かめる）",
  警告: "自動では確かめない（人が確かめる）",
  申告: "〔申告〕人が済ませて設定に書く",
  未検査: "〔未検査〕人が確かめる",
  判断: "判断（人が決める）",
};

function judgeItem(ctx: Context, item: CatalogItem, stepId: string): Judged {
  const probe = item.probe;
  switch (probe.kind) {
    case "item":
      return judgeKey(ctx, probe.key, stepId);
    case "items": {
      const judged = probe.keys.map((key) => judgeKey(ctx, key, stepId));
      const times = judged.map((j) => j.checkedAt).filter((t): t is string => t !== null).sort();
      const stopId = judged.find((j) => j.stopId)?.stopId;
      return {
        level: worstLevel(judged.map((j) => j.level)),
        evidence: judged.map((j) => j.evidence).filter((e) => e !== "").join(SEPARATOR),
        // 最も古い時刻（いちばん古い結果に基づくことを出す）
        checkedAt: times[0] ?? null,
        ...(stopId ? { stopId } : {}),
      };
    }
    case "module":
      return judgeModule(ctx, probe.module, probe.phase);
    case "drift":
      return judgeDrift(ctx, probe.id);
    case "none":
      return { level: "manual", evidence: MANUAL_EVIDENCE[item.kind], checkedAt: null };
  }
}

/**
 * カタログの全項目を評価する。
 *   item   … key と step（カタログの段階の id）が一致する項目の level。無ければ unknown「モジュールが項目を返さなかった」
 *   items  … 各 key を item と同じく評価し、level は最も重いもの、evidence は「／」でつなぐ
 *   module … そのモジュールと段階の結果（error → unknown、!ok → action、ok で「! 」の notes あり → warn、それ以外 ok）
 *   drift  … ずれの確認の結果（fetch が失敗していれば unknown）
 *   none   … manual
 * 段階の level は、その中の項目で最も重いもの。
 */
export function evaluate(
  catalog: Catalog,
  reports: readonly ModuleResultWithTime[],
  drifts: readonly DriftResult[],
  fetchError: string | null,
  options: { checkedAt: string; runErrors?: readonly string[] },
): EvaluatedStatus {
  const ctx: Context = {
    results: reports,
    drifts,
    fetchError,
    checkedAt: options.checkedAt,
    runErrors: options.runErrors ?? [],
  };
  const counts = zeroCounts();
  const steps: SetupStatusStepView[] = catalog.steps.map((step) => {
    const items: SetupStatusItemView[] = step.items.map((item) => {
      const judged = judgeItem(ctx, item, step.id);
      counts[judged.level] += 1;
      return {
        id: item.id,
        title: item.title,
        who: item.who,
        kind: item.kind,
        level: judged.level,
        evidence: clip(judged.evidence),
        stopId: item.stopId ?? judged.stopId ?? null,
        docs: item.docs.map((doc) => ({ file: doc.file, heading: doc.heading })),
        checkedAt: judged.checkedAt,
      };
    });
    return { id: step.id, title: step.title, level: worstLevel(items.map((i) => i.level)), items };
  });
  return { checkedAt: options.checkedAt, counts, steps };
}
