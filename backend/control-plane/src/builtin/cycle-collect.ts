// 周の項目を集める（builtin `cycle-collect`。spec 5.2・5.3・5.10）。毎日、今の周に次を行う:
//   1. 作業場の docs/proposals の draft・review の E-13 を proposal の項目に（PR の状態は GitHub で見る）。
//      main で承認済みになった・PR がマージされたら confirmed、却下・閉じられたら rejected
//   2. main の承認済みで未適用（applied_at が null）の config_change を manual の項目に
//   3. 作用のジョブの E-15（trigger が proposal）の CREATED: と targetIds から、article・campaign・code の中身を埋めて awaiting_review に。
//      失敗・見送り・成果物の無い partial で終わった実行の準備中の項目は failed_check に（差し戻せる。I2）
//   4. キーワードの経路の下書き（content-writer の通常の実行）を article の項目に（sourceRef は strapi:article:<documentId>）
//   5. article-cover の cover-pending・campaign-asset-upload の asset の印を、項目の中身（手順の元）に入れる
//   6. executed の項目を確かめ（confirmed／failed_check）、確かめ済みの article・code が配信に含まれたら反映を記録する
// 最初に、期間が終わったのに閉じていない周があれば閉じる（cycle-close と共通の関数。Ruling 32）。
// 最後に、作業場の docs/cycles/<周 ID>.md に項目と差し戻しの理由の要約を書き出す（理由は周を問わず、この周の期間に更新された項目）。
// awaiting_review より先に進んだ項目の中身は書き換えない（承認した内容と画面の表示がずれないように。Ruling 4）。
// 外部の設定が無い・失敗したときは、その項目（か段）だけを飛ばして続け、要約に理由を書く。
import type { BuiltinHandler, EngineContext, RunResult } from "../context.js";
import type { CycleItem, CycleItemKind, FailureClass, RunRecord } from "../contract.js";
import { cycleOf } from "../cycle/calendar.js";
import { buildConfirmDeps, confirmExecutedItem } from "../cycle/confirm.js";
import { withoutSystemRejections, writeCycleDoc } from "../cycle/cycle-doc.js";
import {
  type PreviewOutcome,
  type PreviewSources,
  articlePreview,
  campaignPreview,
  codePreview,
  createdOf,
  segmentNameOf,
} from "../cycle/previews.js";
import { itemShapeOf, readProposals } from "../cycle/proposals.js";
import { listRecentItems, markReflections } from "../cycle/reflection.js";
import type { Proposal } from "../definitions/proposal.js";
import { GitHubClient } from "../integrations/github.js";
import { IntegrationError } from "../integrations/http.js";
import { MauticReader } from "../integrations/mautic.js";
import { StrapiClient } from "../integrations/strapi.js";
import { logLine } from "../log.js";
import { redactSummary } from "../pii.js";
import type { UpsertCycleItemInput } from "../store/cycles.js";
import { toIsoJst } from "../time.js";
import { closeStaleCycles, skipped } from "./cycle.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 実行の記録を見る範囲（今の周の始まりから遡る日数。前の周の終わりに動いた作用のジョブを拾う） */
const RUN_LOOKBACK_DAYS = 14;
const TITLE_MAX = 100;
const PROPOSAL_ID = /^PRP-\d{4}-\d{4}$/;
/** 作用のジョブのエージェントと、作る項目の種類 */
const AGENT_KIND: Record<string, CycleItemKind> = {
  "content-writer": "article",
  "campaign-planner": "campaign",
  "design-implementer": "code",
};
/** キーワードの経路で、CREATED: が無い古い実行の targetIds から記事を探すときに試す数の上限 */
const KEYWORD_FALLBACK_MAX = 3;
/** 中身を書き換えてよい状態 */
const OPEN_STATES: readonly CycleItem["state"][] = ["preparing", "awaiting_review"];

function titleOf(text: string): string {
  return redactSummary(Array.from(text).slice(0, TITLE_MAX).join("")).text;
}

function evidenceOf(proposal: Proposal): CycleItem["evidence"] {
  return proposal.evidence.map((e) => ({ auditId: e.audit_id, summary: redactSummary(e.summary).text }));
}

const isFinishedOk = (run: RunRecord) => run.status === "finished" && (run.outcome === "success" || run.outcome === "partial");

class Collector {
  readonly notes: string[] = [];
  readonly counts = { proposals: 0, manual: 0, filled: 0, keyword: 0, confirmed: 0, failedCheck: 0, reflected: 0 };
  failureClass: FailureClass | null = null;
  failed = false;

  constructor(
    readonly ctx: EngineContext,
    readonly cycleId: string,
    readonly runId: string,
  ) {}

  /** 1 つの段・項目の失敗を記録して続ける（外部の失敗以外は内部エラーとして上に返す） */
  async step(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      this.failed = true;
      this.failureClass ??= error.failureClass;
      this.notes.push(`${label}: 外部の呼び出しに失敗（${error.failureClass}）`);
      logLine("WARN", "cycle-collect", `${label}: ${error.message}`, this.runId);
    }
  }

  /** 中身を書き換えてよい項目だけを upsert する（Ruling 4）。書いたら項目、書かなければ null */
  upsertIfOpen(input: Omit<UpsertCycleItemInput, "cycleId">): CycleItem | null {
    const existing = this.ctx.cycles.findItem(input.kind, input.sourceRef);
    if (existing && !OPEN_STATES.includes(existing.state)) return null;
    return this.ctx.cycles.upsertItem({ ...input, cycleId: this.cycleId });
  }
}

/** 1. 起票中の E-13 と、その PR の状態 */
async function collectProposals(
  c: Collector,
  github: GitHubClient | null,
  repository: string | null,
  worktreeProposals: Proposal[],
  mainById: Map<string, Proposal>,
  recent: CycleItem[],
): Promise<void> {
  const { cycles } = c.ctx;
  const prNumberOf = (proposal: Proposal | undefined) => {
    const match = /PR #(\d+)/.exec(proposal?.change.diff_ref ?? "");
    return match ? Number(match[1]) : null;
  };
  const targets = new Map<string, Proposal | undefined>();
  for (const proposal of worktreeProposals) {
    if (proposal.approval.state === "draft" || proposal.approval.state === "review") targets.set(proposal.proposal_id, proposal);
  }
  // 作業場のファイルが main の版に置き換わった（cycle-open の合わせ）後も、開いている項目は確かめ続ける
  for (const item of recent) {
    if (item.kind === "proposal" && OPEN_STATES.includes(item.state) && !targets.has(item.sourceRef)) targets.set(item.sourceRef, undefined);
  }

  for (const [proposalId, draft] of targets) {
    await c.step(proposalId, async () => {
      const main = mainById.get(proposalId);
      const existing = cycles.findItem("proposal", proposalId);
      const prNumber = prNumberOf(draft) ?? prNumberOf(main) ?? (existing?.preview.kind === "proposal" ? existing.preview.prNumber : null);
      const pull = github && prNumber !== null ? await github.getPullRequest(prNumber) : null;
      const prState = pull ? (pull.merged ? "merged" : pull.state === "closed" ? "closed" : pull.approved ? "approved" : "open") : null;
      const source = draft ?? main;
      let item = existing;
      if (source) {
        const written = c.upsertIfOpen({
          kind: "proposal",
          stage: "propose",
          sourceRef: proposalId,
          proposalId,
          title: titleOf(source.change.description),
          summary: titleOf(`${source.change.kind}: ${source.target.entity} ${source.target.identifier}`),
          evidence: evidenceOf(source),
          preview: { kind: "proposal", prNumber, prState, prUrl: repository && prNumber !== null ? `https://github.com/${repository}/pull/${prNumber}` : null },
          state: "awaiting_review",
        });
        if (written) {
          item = written;
          c.counts.proposals++;
        }
      }
      if (!item || !OPEN_STATES.includes(item.state)) return;
      const mainState = main?.approval.state;
      if (mainState === "approved" || mainState === "applied" || prState === "merged") {
        cycles.transition(item.itemId, [...OPEN_STATES], "confirmed", "PR がマージされた（main で承認済み）");
      } else if (mainState === "rejected" || prState === "closed") {
        cycles.transition(item.itemId, [...OPEN_STATES], "rejected", "PR が閉じられた・E-13 が却下された");
      }
    });
  }
}

/** 2. 承認済みで未適用の config_change（人が手で行う） */
function collectManual(c: Collector, mainProposals: Proposal[]): void {
  for (const proposal of mainProposals) {
    if (proposal.approval.state !== "approved" || proposal.change.kind !== "config_change" || proposal.applied_at !== null) continue;
    const written = c.upsertIfOpen({
      kind: "manual",
      stage: "publish",
      sourceRef: proposal.proposal_id,
      proposalId: proposal.proposal_id,
      title: titleOf(proposal.change.description),
      summary: titleOf(`config_change: ${proposal.target.entity} ${proposal.target.identifier}`),
      evidence: evidenceOf(proposal),
      preview: { kind: "manual", description: titleOf(proposal.change.description) },
      state: "awaiting_review",
    });
    if (written) c.counts.manual++;
  }
}

/** 作用の実行の E-13。targetIds の proposal_id、無ければ実行の開始と同じ時刻に作られた準備中の項目 */
function proposalIdOfRun(run: RunRecord, kind: CycleItemKind, recent: CycleItem[]): string | null {
  const fromIds = run.targetIds.find((id) => PROPOSAL_ID.test(id));
  if (fromIds) return fromIds;
  const started = Date.parse(run.startedAt);
  const match = recent.find((item) => item.kind === kind && item.proposalId && Math.abs(Date.parse(item.createdAt) - started) < 60_000);
  return match?.proposalId ?? null;
}

/** 作用の実行が成果物を残したか（CREATED: の行。code は targetIds の公開サイトのファイルも数える） */
function hasArtifacts(run: RunRecord, kind: CycleItemKind): boolean {
  if (createdOf(run).size > 0) return true;
  return kind === "code" && run.targetIds.some((id) => id.startsWith("frontend/"));
}

const OUTCOME_LABEL: Record<NonNullable<RunRecord["outcome"]>, string> = {
  success: "成功",
  failure: "失敗",
  partial: "一部の失敗（成果物なし）",
  skipped: "見送り",
};

/** 作用のジョブが止まった準備中の項目を failed_check にする（理由に実行の結果と run_id の先頭） */
function markActionFailed(c: Collector, item: CycleItem, run: RunRecord): void {
  const outcome = run.outcome ? OUTCOME_LABEL[run.outcome] : "不明";
  const detail = run.summary ? `。${Array.from(run.summary).slice(0, 80).join("")}` : "";
  const reason = `作用のジョブが「${outcome}」で終わった（実行 ${run.runId.slice(0, 10)}${detail}）。差し戻すと閉じる（この E-13 は作用のジョブに選び直されない）`;
  if (c.ctx.cycles.transition(item.itemId, ["preparing"], "failed_check", reason)) {
    c.counts.failedCheck++;
    c.notes.push(`${item.sourceRef}: 作用のジョブが「${outcome}」で終わったため、確かめられなかった項目にした`);
  }
}

/** 3. 作用のジョブの成果物から、article・campaign・code の中身を埋める */
async function collectActionRuns(
  c: Collector,
  runs: RunRecord[],
  src: PreviewSources,
  mainById: Map<string, Proposal>,
  recent: CycleItem[],
): Promise<void> {
  const { cycles } = c.ctx;
  const seen = new Set<string>();
  // 新しい実行を先に見る（同じ E-13 は、いちばん新しい終わった実行の 1 回だけ）
  for (const run of [...runs].reverse()) {
    if (run.trigger !== "proposal" || run.status !== "finished" || !run.agentName) continue;
    const kind = AGENT_KIND[run.agentName];
    if (!kind) continue;
    const proposalId = proposalIdOfRun(run, kind, recent);
    if (!proposalId || seen.has(`${kind}:${proposalId}`)) continue;
    seen.add(`${kind}:${proposalId}`);

    // 作用のジョブが失敗・見送り・成果物の無い partial で終わったら、準備中の項目を failed_check にする（I2。準備中のまま止めない）。
    // 差し戻せる。差し戻しても E-13 は項目を持つので、作用のジョブに選び直されない
    const failed = run.outcome === "failure" || run.outcome === "skipped" || (run.outcome === "partial" && !hasArtifacts(run, kind));
    if (failed) {
      const item = cycles.findItem(kind, proposalId);
      if (item?.state === "preparing") markActionFailed(c, item, run);
      continue;
    }

    await c.step(proposalId, async () => {
      const proposal = mainById.get(proposalId);
      let item = cycles.findItem(kind, proposalId);
      if (!item) {
        // 起点が無いまま起動して準備中の項目が作られなかった実行。E-13 から形を決めて作る
        const shape = proposal ? itemShapeOf(proposal.change.kind) : null;
        if (!proposal || !shape || shape.kind !== kind) return;
        item = cycles.upsertItem({
          cycleId: c.cycleId,
          kind,
          stage: shape.stage,
          sourceRef: proposalId,
          proposalId,
          title: titleOf(proposal.change.description),
          summary: titleOf(proposal.change.description),
          evidence: evidenceOf(proposal),
          preview: { kind: "pending" },
        });
      }
      if (!OPEN_STATES.includes(item.state)) return;

      const created = createdOf(run);
      let outcome: PreviewOutcome<CycleItem["preview"]>;
      if (kind === "article") {
        const documentId = created.get("article")?.[0];
        outcome = documentId ? await articlePreview(documentId, src) : { note: "作用のジョブの結果に記事の ID（CREATED: article=）が無い" };
      } else if (kind === "campaign") {
        outcome = await campaignPreview(proposalId, created, proposal ? segmentNameOf(proposal.target.identifier) : null, src);
      } else {
        const files = [...(created.get("file") ?? []), ...run.targetIds.filter((id) => id.startsWith("frontend/"))];
        outcome = await codePreview(proposalId, files, src.worktree, src.signal);
      }

      if ("note" in outcome) {
        // 中身を作れない。準備中に戻して理由を出す（作用のジョブが止まった理由は E-15 の要約にある）。
        // OK 待ちの項目も準備中に戻す（今の中身を作れないのに、前に作った中身のまま OK を出させない。I4）
        cycles.transition(item.itemId, [...OPEN_STATES], "preparing", `${outcome.note}（実行 ${run.runId}）`);
        c.notes.push(`${proposalId}: ${outcome.note}`);
        return;
      }
      c.upsertIfOpen({
        kind,
        stage: item.stage,
        sourceRef: proposalId,
        proposalId,
        title: item.title,
        summary: item.summary,
        evidence: item.evidence,
        preview: outcome.preview,
        state: "awaiting_review",
      });
      c.counts.filled++;
    });
  }
}

/** 4. キーワードの経路の下書き（content-writer の通常の実行） */
async function collectKeywordDrafts(c: Collector, runs: RunRecord[], src: PreviewSources): Promise<void> {
  if (!src.strapi) {
    if (runs.some((run) => run.agentName === "content-writer" && run.trigger !== "proposal" && isFinishedOk(run))) {
      c.notes.push("キーワード由来の記事: Strapi の読み取りの設定が無いため集めなかった");
    }
    return;
  }
  const seen = new Set<string>();
  for (const run of [...runs].reverse()) {
    if (run.agentName !== "content-writer" || run.trigger === "proposal" || !isFinishedOk(run)) continue;
    const created = createdOf(run).get("article");
    // CREATED: が無い古い実行は、targetIds（企画の documentId と記事の documentId）を下書きとして引いてみる
    const candidates = created ?? run.targetIds.filter((id) => /^[A-Za-z0-9]{8,64}$/.test(id)).slice(0, KEYWORD_FALLBACK_MAX);
    for (const documentId of candidates) {
      if (seen.has(documentId)) continue;
      seen.add(documentId);
      const sourceRef = `strapi:article:${documentId}`;
      const existing = c.ctx.cycles.findItem("article", sourceRef);
      if (existing && !OPEN_STATES.includes(existing.state)) continue;
      await c.step(sourceRef, async () => {
        const outcome = await articlePreview(documentId, src);
        if ("note" in outcome) return;
        c.upsertIfOpen({
          kind: "article",
          stage: "draft",
          sourceRef,
          proposalId: null,
          title: titleOf(`記事: ${outcome.preview.titleText || documentId}`),
          summary: "キーワードの経路（キーワード → 企画 → 下書き）の記事の下書き",
          evidence: [],
          preview: outcome.preview,
          state: "awaiting_review",
        });
        c.counts.keyword++;
      });
    }
  }
}

/** 5. article-cover・campaign-asset-upload の印 */
function markersOf(runs: RunRecord[]): { coverPending: Map<string, number>; uploadedAssets: Map<string, Set<number>> } {
  const coverPending = new Map<string, number>();
  const uploadedAssets = new Map<string, Set<number>>();
  for (const run of runs) {
    for (const id of run.targetIds) {
      const cover = /^cover-pending:([A-Za-z0-9]+):(\d+)$/.exec(id);
      if (run.builtin === "article-cover" && cover) coverPending.set(cover[1]!, Number(cover[2]));
      const asset = /^asset:(PRP-\d{4}-\d{4}):(\d+)$/.exec(id);
      if (run.builtin === "campaign-asset-upload" && asset) {
        uploadedAssets.set(asset[1]!, (uploadedAssets.get(asset[1]!) ?? new Set()).add(Number(asset[2])));
      }
    }
  }
  return { coverPending, uploadedAssets };
}

/** 6. executed の項目を確かめ、反映を記録する */
async function confirmAndReflect(c: Collector, signal: AbortSignal): Promise<void> {
  const { ctx } = c;
  const deps = buildConfirmDeps(ctx, signal);
  const confirmedDeploys: string[] = [];
  for (const item of listRecentItems(ctx.cycles).filter((i) => i.state === "executed")) {
    if (signal.aborted) return;
    const result = await confirmExecutedItem(ctx, item, deps);
    if (!result) continue;
    if (result.ok) {
      c.counts.confirmed++;
      if (item.kind === "deploy") confirmedDeploys.push(item.itemId);
      // campaign は送信の確認の時点で反映済み（confirmExecutedItem が記録した）
      if (item.kind === "campaign") c.counts.reflected++;
    } else if (!result.pending) {
      c.counts.failedCheck++;
    }
  }
  await c.step("反映の記録", async () => {
    const byDeploy = await markReflections(ctx.cycles, listRecentItems(ctx.cycles), {
      kv: ctx.kv,
      siteUrl: ctx.config.siteUrl,
      github: deps.github,
      issueNumber: deps.issueNumber,
    });
    for (const [deployId, proposalIds] of byDeploy) {
      c.counts.reflected += proposalIds.length;
      // 今回確かめた deploy には、含まれた E-13 を理由に残す（手順に applied_at の記録を出す）
      if (confirmedDeploys.includes(deployId)) {
        ctx.cycles.transition(deployId, ["confirmed"], "confirmed", `確かめた。含まれる E-13: ${[...new Set(proposalIds)].join(", ")}`);
      }
    }
  });
}

export const cycleCollect: BuiltinHandler = async ({ ctx, runId, signal }): Promise<RunResult> => {
  const { config, cycles } = ctx;
  if (!config.cycleAnchor) return skipped("cycle-collect", "CONTROL_CYCLE_ANCHOR が無い");
  const now = cycleOf(new Date(), config.cycleAnchor);
  cycles.openCycle(now.cycleId, now.startsAt, now.endsAt, false);
  const c = new Collector(ctx, now.cycleId, runId);
  // 期間が終わったのに閉じていない周があれば、cycle-close と同じ数え方と知らせで閉じる（cycle-open・cycle-close が動かなかったとき。Ruling 32）
  c.notes.push(...(await closeStaleCycles(ctx, signal, runId)));

  const runs = ctx.runs.startedSince(toIsoJst(new Date(Date.parse(now.startsAt) - RUN_LOOKBACK_DAYS * DAY_MS)));
  const [worktreeProposals, mainProposals] = [await readProposals(config.worktree), await readProposals(config.mainCheckout)];
  const mainById = new Map(mainProposals.map((proposal) => [proposal.proposal_id, proposal]));
  const github = config.github ? new GitHubClient(config.github, signal) : null;
  const markers = markersOf(runs);
  const src: PreviewSources = {
    strapi: config.strapi ? new StrapiClient(config.strapi.baseUrl, config.strapi.readToken, null) : null,
    strapiBaseUrl: config.strapi?.baseUrl ?? null,
    mautic: config.mautic ? new MauticReader(config.mautic, signal) : null,
    siteUrl: config.siteUrl,
    worktree: config.worktree,
    kv: ctx.kv,
    ...markers,
    signal,
  };

  if (!github) c.notes.push("GitHub の設定が無いため、PR の状態を読まなかった");
  await collectProposals(c, github, config.github?.repository ?? null, worktreeProposals, mainById, listRecentItems(cycles));
  collectManual(c, mainProposals);
  if (!signal.aborted) await collectActionRuns(c, runs, src, mainById, listRecentItems(cycles));
  if (!signal.aborted) await collectKeywordDrafts(c, runs, src);
  if (!signal.aborted) await confirmAndReflect(c, signal);

  const cycle = cycles.getCycle(now.cycleId);
  let docWritten = false;
  if (cycle) {
    try {
      docWritten = await writeCycleDoc(
        config.worktree,
        cycle,
        cycles.listItems(now.cycleId),
        // システムが行った置き換えの差し戻しは、差し戻しの節に載せない（人の判断ではなく、次の周への雑音になるため）
        withoutSystemRejections(cycles, cycles.listItemsUpdatedBetween(cycle.startsAt, cycle.endsAt)),
      );
    } catch (error) {
      c.failed = true;
      c.notes.push("docs/cycles の書き出しに失敗した");
      logLine("WARN", "cycle-collect", `docs/cycles の書き出しに失敗: ${error instanceof Error ? error.message : "不明"}`, runId);
    }
  }

  const { counts } = c;
  const summary = [
    `${now.cycleId}（${now.day} 日目）: 改修案 ${counts.proposals}・手作業 ${counts.manual}・中身を埋めた ${counts.filled}・キーワード由来 ${counts.keyword}・確かめた ${counts.confirmed}・確かめられなかった ${counts.failedCheck}・反映を記録した E-13 ${counts.reflected}`,
    docWritten ? "docs/cycles を書き出した" : null,
    signal.aborted ? "停止要求かタイムアウトで途中までにした" : null,
    ...c.notes.slice(0, 10),
  ]
    .filter((line) => line !== null)
    .join("。");
  return { outcome: c.failed ? "partial" : "success", summary, targetIds: [now.cycleId], failureClass: c.failed ? c.failureClass : null };
};
