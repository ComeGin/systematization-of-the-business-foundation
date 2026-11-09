// 改善ループの周の始まりと終わり（builtin `cycle-open`・`cycle-close`。spec 5.1・5.2・5.10）。
//   cycle-open:  周の 0 日目に今日の周を開く。期間が終わって閉じていない周があれば数えて閉じる。作業場（CONTROL_WORKTREE）の
//                変更がエージェントの書く場所の未追跡のファイルだけで、detached HEAD のときだけ origin/main に合わせる
//                （Ruling 19・34。git はシェルを通さない。名前のあるブランチ＝人の作業ブランチにいるときは動かさない）。
//   cycle-close: 期間が終わった周（今 >= 周の終わり）を、反映の件数と止まっている場所を数えて閉じる（Ruling 32。月曜 00:05 に動く）。
//                E-13 由来もキーワード由来も 0 件なら知らせる。期間の途中の周は、手で起動しても閉じない（closeCycle は取り消せない）。
//                閉じる前に今日の周を開く（冪等。どのジョブも動かなかった周の行を作る。P9）。
// cycle-open は定期実行のときだけ日を判定する（画面から手で起動したときは日を問わない）。
// 項目を集める cycle-collect は builtin/cycle-collect.ts（最初に、期間が終わった周を同じ関数で閉じる）。
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinHandler, BuiltinInput, EngineContext, RunResult } from "../context.js";
import type { CycleCloseResult, CycleRow } from "../contract.js";
import { cycleOf } from "../cycle/calendar.js";
import { runGit } from "../cycle/git.js";
import { countReflection, listRecentItems, markReflections } from "../cycle/reflection.js";
import { GitHubClient } from "../integrations/github.js";
import { IntegrationError } from "../integrations/http.js";
import { logLine } from "../log.js";
import { sendNotifications } from "../status/notify.js";

/** 作業場の git の 1 回の打ち切り（fetch はネットワークを使うので長め） */
const GIT_STATUS_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 120_000;
const GIT_CHECKOUT_TIMEOUT_MS = 60_000;
const GIT_OBJECT_TIMEOUT_MS = 10_000;

/** エージェント（と cycle-collect）が書く場所。ここの未追跡のファイルだけなら同期してよい（Ruling 19） */
const AGENT_WRITTEN_DIRS = ["docs/audits/", "docs/proposals/", "docs/cycles/"] as const;
/**
 * E-13 の写し。origin/main に同じパスがあれば、中身が違っても消してよい（Ruling 22）。
 * i13-file は diff_ref: null の本文を PR にコミットし、作業場の写しにだけ diff_ref: PR #n を書き戻すため、マージ後も必ず中身が違う。
 * main の版が承認を経た正本
 */
const PROPOSAL_COPY = /^docs\/proposals\/PRP-\d{4}-\d{4}\.md$/;

const NOTIFY_SUBJECT = "[ComeGin 改善ループ] この周は反映できなかった";

const STUCK_LABEL: Record<keyof CycleCloseResult["stuck"], string> = {
  no_proposal: "改修案が出なかった",
  pr_not_approved: "PR が承認されていない",
  awaiting_review: "OK 待ち（準備中を含む）",
  not_executed: "実行されていない（確かめられなかったを含む）",
  not_deployed: "配信されていない",
};

export function skipped(job: string, reason: string): RunResult {
  return { outcome: "skipped", summary: `${job} を見送った（${reason}）`, targetIds: [], skipReason: reason };
}

/** 画面から手で起動したか（定期実行でなければ、周の何日目かを問わない） */
export function isManualRun(input: BuiltinInput): boolean {
  if (input.job === null) return true;
  return input.ctx.runs.get(input.runId)?.trigger === "manual";
}

export function describeClose(result: CycleCloseResult): string {
  const stuck = Object.entries(result.stuck)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${STUCK_LABEL[key as keyof CycleCloseResult["stuck"]]} ${n}`)
    .join("・");
  return `反映 E-13 由来 ${result.reflectedFromProposals}・キーワード由来 ${result.reflectedFromKeywords}${stuck ? `。止まっている場所: ${stuck}` : ""}`;
}

/**
 * 周を数えて閉じる。既に閉じていれば何もしない（1 回目の結果を変えない）。
 * 両方 0 件なら、設定の状況の知らせ（SNS）があれば 1 通送る。知らせるのは、この呼び出しで実際に閉じたときだけ
 * （cycle の行が古くても、closeCycle の戻り値で判定する。別のジョブと二重に知らせない。Ruling 23）。戻り値は要約の文。
 */
export async function closeCycleAndNotify(ctx: EngineContext, cycle: CycleRow, signal: AbortSignal, runId: string): Promise<string> {
  if (cycle.closedAt) return `${cycle.cycleId} は閉じてある`;
  const result = countReflection(listRecentItems(ctx.cycles), cycle);
  if (!ctx.cycles.closeCycle(cycle.cycleId, result)) return `${cycle.cycleId} は別の実行が閉じた`;
  const text = `${cycle.cycleId} を閉じた（${describeClose(result)}）`;
  if (result.reflectedFromProposals + result.reflectedFromKeywords > 0) return text;

  const status = ctx.config.status;
  if (!status) return `${text}。反映 0 件だが、知らせの設定が無い（CONTROL_SETUP_STATUS_ENABLED）ため知らせなかった`;
  const lines = [
    `改善ループの周 ${cycle.cycleId}（${cycle.startsAt.slice(0, 10)} から 14 日）は、公開サイトへの反映が 0 件だった。`,
    "",
    "止まっている場所:",
    ...Object.entries(result.stuck).map(([key, n]) => `- ${STUCK_LABEL[key as keyof CycleCloseResult["stuck"]]}: ${n}`),
    "",
    `画面: ${status.linkBase}/cycle/${cycle.cycleId}`,
  ];
  const sent = await sendNotifications([{ subject: NOTIFY_SUBJECT, body: lines.join("\n") }], status, undefined, signal);
  if (!sent.ok) {
    logLine("WARN", "cycle", `反映 0 件の知らせを送れなかった（${sent.reason}）`, runId);
    return `${text}。反映 0 件の知らせを送れなかった（${sent.reason}）`;
  }
  return `${text}。反映 0 件の知らせを送った`;
}

/**
 * 確かめ済みの配信に含まれた article・code の反映を記録する（cycle-collect の markReflections と同じ）。
 * 外部（GitHub）の失敗は WARN にして続ける（記録できなかった反映は、次の cycle-collect が記録する）
 */
async function markReflectionsBeforeClose(ctx: EngineContext, signal: AbortSignal, runId: string): Promise<void> {
  const { config } = ctx;
  try {
    await markReflections(ctx.cycles, listRecentItems(ctx.cycles), {
      kv: ctx.kv,
      siteUrl: config.siteUrl,
      github: config.github ? new GitHubClient(config.github, signal) : null,
      issueNumber: config.github?.issueNumber ?? null,
    });
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    logLine("WARN", "cycle", `周を閉じる前の反映の記録に失敗した（${error.failureClass}）`, runId);
  }
}

/**
 * 期間が終わった（now >= endsAt）のに閉じていない周をすべて数えて閉じる（cycle-open・cycle-collect・cycle-close が共通で使う。Ruling 32）。
 * 期間の途中の周は閉じない（周の終わりの日に確かめた反映も、その周に数えるため）。
 * 0 件の周は closeCycleAndNotify が知らせる。戻り値は要約の文の一覧（閉じた周が無ければ空）。
 */
export async function closeStaleCycles(ctx: EngineContext, signal: AbortSignal, runId: string, now: Date = new Date()): Promise<string[]> {
  const notes: string[] = [];
  const ended = (cycle: CycleRow) => !cycle.closedAt && now.getTime() >= Date.parse(cycle.endsAt);
  const targets = ctx.cycles.listCycles(20).filter(ended);
  // 周の終わりの前に画面で確かめた配信の反映（cycle-collect がまだ記録していないもの）を、数える前に記録する
  if (targets.length > 0) await markReflectionsBeforeClose(ctx, signal, runId);
  for (const previous of targets) {
    if (signal.aborted) break;
    notes.push(await closeCycleAndNotify(ctx, previous, signal, runId));
  }
  return notes;
}

/** git status --porcelain -z の 1 件（XY と パス）。リネームの元のパスの欄は読み飛ばす */
function parseStatusZ(stdout: string): { code: string; path: string }[] {
  const fields = stdout.split("\0").filter((field) => field !== "");
  const entries: { code: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code.includes("R") || code.includes("C")) i++;
  }
  return entries;
}

/**
 * 作業場を origin/main に合わせる（Ruling 19・34）。
 *   - 作業場が名前のあるブランチにいるとき（detached HEAD でない）は合わせない（人の作業ブランチを動かさない）
 *   - 変更がエージェントの書く場所（docs/audits/・docs/proposals/・docs/cycles/）の未追跡のファイルだけなら進める。
 *     追跡済みのファイルの変更・それ以外の場所（frontend/verdant-virgo/src・campaign-assets/ など）の変更があれば合わせない（人のコミット待ち）
 *   - fetch の後、未追跡のファイルのうち origin/main に同じパスがあるものを調べる:
 *       docs/proposals/PRP-*.md（E-13 の写し）は、中身が違っても消す（Ruling 22。main の版が正本）
 *       それ以外（docs/audits/・docs/cycles/ など）は、同じ中身のときだけ消す。違うものが 1 つでもあれば合わせない（件数だけ。パスは出さない）
 *     origin/main に無いパスのファイルは checkout を妨げないので、消さずに残す
 *   - 最後に checkout --detach origin/main
 */
export async function syncWorktree(worktree: string, runId: string, signal: AbortSignal): Promise<{ synced: boolean; note: string }> {
  const git = (args: string[], timeoutMs: number) => runGit(worktree, args, { timeoutMs, signal });
  // 名前のあるブランチにいる作業場は、人の作業ブランチ（開発のリポジトリ・code の項目の手順で作ったブランチ）とみなして動かさない（Ruling 34）。
  // symbolic-ref が成功する＝ブランチにいる。detached HEAD なら失敗する
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], GIT_OBJECT_TIMEOUT_MS);
  if (branch.ok) {
    return {
      synced: false,
      note: "作業場が名前のあるブランチにいるため合わせなかった（人の作業ブランチは動かさない。PR を作り終えたら git switch --detach origin/main で戻すと、次から合わせる）",
    };
  }
  const status = await git(["status", "--porcelain", "-z", "--untracked-files=all"], GIT_STATUS_TIMEOUT_MS);
  if (!status.ok) return { synced: false, note: "作業場の git status を読めなかったため合わせなかった" };
  const entries = parseStatusZ(status.stdout);
  const tracked = entries.filter((entry) => entry.code !== "??").length;
  const elsewhere = entries.filter((entry) => entry.code === "??" && !AGENT_WRITTEN_DIRS.some((dir) => entry.path.startsWith(dir))).length;
  if (tracked > 0 || elsewhere > 0) {
    return {
      synced: false,
      note: `作業場に人のコミットを待つ変更がある（追跡済みの変更 ${tracked} 件・エージェントの書く場所の外の未追跡 ${elsewhere} 件）ため合わせなかった`,
    };
  }

  const fetched = await git(["fetch", "origin"], GIT_FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    logLine("WARN", "cycle", "作業場の git fetch origin に失敗した", runId);
    return { synced: false, note: "作業場の git fetch に失敗したため合わせなかった" };
  }

  const removable: string[] = [];
  let differing = 0;
  for (const { path } of entries) {
    if (signal.aborted) return { synced: false, note: "停止要求で合わせるのをやめた" };
    if (path.split("/").includes("..")) {
      differing++;
      continue;
    }
    const upstream = await git(["rev-parse", "--verify", "--quiet", `origin/main:${path}`], GIT_OBJECT_TIMEOUT_MS);
    // origin/main に無いパスは checkout を妨げないので残す
    if (!upstream.ok) continue;
    if (PROPOSAL_COPY.test(path)) {
      removable.push(path);
      continue;
    }
    const local = await git(["hash-object", "--", path], GIT_OBJECT_TIMEOUT_MS);
    if (local.ok && local.stdout.trim() === upstream.stdout.trim()) removable.push(path);
    else differing++;
  }
  if (differing > 0) {
    return { synced: false, note: `作業場の未追跡のファイル ${differing} 件が origin/main の同じパスと中身が違うため合わせなかった` };
  }
  try {
    for (const path of removable) await unlink(join(worktree, path));
  } catch (error) {
    logLine("WARN", "cycle", `作業場の未追跡のファイルを消せなかった: ${error instanceof Error ? error.name : "不明"}`, runId);
    return { synced: false, note: "main にもある未追跡のファイルを消せなかったため合わせなかった" };
  }

  const checkedOut = await git(["checkout", "--detach", "origin/main"], GIT_CHECKOUT_TIMEOUT_MS);
  if (!checkedOut.ok) {
    logLine("WARN", "cycle", "作業場の git checkout --detach origin/main に失敗した", runId);
    return { synced: false, note: `作業場を origin/main に切り替えられなかった（main にもある未追跡のファイル ${removable.length} 件は消した）` };
  }
  return { synced: true, note: `作業場を origin/main に合わせた（main にもある未追跡のファイル ${removable.length} 件を消した）` };
}

export const cycleOpen: BuiltinHandler = async (input): Promise<RunResult> => {
  const { ctx, runId, signal } = input;
  const { config, cycles } = ctx;
  if (!config.cycleAnchor) return skipped("cycle-open", "CONTROL_CYCLE_ANCHOR が無い");
  const now = cycleOf(new Date(), config.cycleAnchor);
  const manual = isManualRun(input);
  if (!manual && now.day !== 0) return skipped("cycle-open", `周の ${now.day} 日目`);

  // 手で 0 日目以外に開いたときは、設定の起点からのずれとして manual に残す
  cycles.openCycle(now.cycleId, now.startsAt, now.endsAt, manual && now.day !== 0);
  const notes = [`${now.cycleId} を開いた（周の ${now.day} 日目）`, ...(await closeStaleCycles(ctx, signal, runId))];

  if (!config.worktreeSync) notes.push("作業場の合わせは無効（CONTROL_WORKTREE_SYNC=false）");
  else if (!signal.aborted) notes.push((await syncWorktree(config.worktree, runId, signal)).note);

  return { outcome: "success", summary: notes.join("。"), targetIds: [now.cycleId] };
};

export const cycleClose: BuiltinHandler = async (input): Promise<RunResult> => {
  const { ctx, runId, signal } = input;
  const { config } = ctx;
  if (!config.cycleAnchor) return skipped("cycle-close", "CONTROL_CYCLE_ANCHOR が無い");
  const now = cycleOf(new Date(), config.cycleAnchor);

  // 閉じるのは期間が終わった周だけ（Ruling 32。手で起動しても、期間の途中の周は閉じない）。
  // 周の終わりの日に確かめた反映もその周に数えるため、周の終わり（次の周の 0 日目の 00:00）の後に動く。
  // cycle-open・cycle-collect が先に閉じていれば何もしない（知らせるかは closeCycle の戻り値で決める。Ruling 23）
  // 今日の周も開く（冪等）。cycle-open・cycle-collect・published-article-check のどれも動かなかった周は行が作られず、閉じられないため（P9）
  ctx.cycles.openCycle(now.cycleId, now.startsAt, now.endsAt, false);
  const notes = await closeStaleCycles(ctx, signal, runId);
  if (notes.length === 0) return skipped("cycle-close", `期間が終わって閉じていない周が無い（今は ${now.cycleId} の ${now.day} 日目）`);
  return { outcome: "success", summary: notes.join("。"), targetIds: [] };
};
