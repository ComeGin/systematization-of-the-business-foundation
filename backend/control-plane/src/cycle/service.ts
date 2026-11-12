// 画面向けの改善ループの操作（ControlPlane の getCycle・approveCycleItem など。spec 5.3〜5.5・5.10）。
// 状態の遷移は CycleStore.transition が「今の状態が from にあるときだけ」行う（二重送信・古い画面からの操作を弾く）。
// 画面に出す理由は redactSummary を通して保存する。確認項目・手順は承認済み main から読む（ADR-18）。
import { itemSnapshotKey } from "../builtin/published-article-check.js";
import type { EngineContext } from "../context.js";
import type { CycleId, CycleItem, CycleItemState, CycleRow, CycleStage, CycleView, Ulid } from "../contract.js";
import { ControlPlaneInputError } from "../errors.js";
import { logLine } from "../log.js";
import { redactSummary } from "../pii.js";
import { toIsoJst } from "../time.js";
import { ULID_PATTERN } from "../ulid.js";
import { CYCLE_LENGTH_DAYS, cycleOf } from "./calendar.js";
import { type Checklists, ChecklistError, loadChecklists } from "./checklists.js";
import { buildStepsContext, itemStrapiAdminUrl, stepsFor } from "./commands.js";
import { buildConfirmDeps, confirmExecutedItem } from "./confirm.js";
import { readProposals } from "./proposals.js";
import { type StageRunner, orderStageJobs } from "./stage-runner.js";
import { countReflection, listRecentItems } from "./reflection.js";

const CYCLE_ID_PATTERN = /^C-\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_CYCLES_LIMIT = 50;
const ACTOR_MAX_LENGTH = 200;
const REJECT_REASON_MAX_LENGTH = 500;
/** 「実行した」の後の確かめの打ち切り（外部の呼び出しは 1 件 15 秒で切れるが、項目によって何回か呼ぶ） */
const CONFIRM_TIMEOUT_MS = 60_000;

/** 画面の ①〜⑦（この順） */
export const STAGES: readonly CycleStage[] = ["collect", "propose", "draft", "review", "publish", "evaluate", "deploy"];

/** 段階ごとの、定期実行のジョブの id の判定（定義に無い id は出さない）。review は人の確認だけでジョブが無い */
const STAGE_JOB: Record<CycleStage, (jobId: string) => boolean> = {
  collect: (id) => id.startsWith("daily-observe-"),
  propose: (id) => id === "daily-propose",
  draft: (id) =>
    id.startsWith("weekly-content-") || ["cycle-apply-content", "cycle-campaign", "article-cover", "campaign-asset-upload"].includes(id),
  review: () => false,
  publish: (id) => id === "cycle-collect",
  evaluate: (id) => ["weekly-lighthouse", "weekly-a11y", "cycle-apply-code"].includes(id),
  deploy: (id) => id === "published-article-check",
};

/**
 * 「今すぐ実行」で 1 回で通すときの順（定期実行の時刻の順と違う段階だけ。2026-11-12）。
 * ③: 企画 → 初稿 → 改修案の反映（記事の下書き）→ キャンペーン（記事とメール）→ アイキャッチ（できた下書きに付ける）→ 配布ファイル（キャンペーンの記事に結ぶ）
 */
const STAGE_ORDER: Partial<Record<CycleStage, readonly string[]>> = {
  draft: ["weekly-content-plan", "weekly-content-draft", "cycle-apply-content", "cycle-campaign", "article-cover", "campaign-asset-upload"],
};

/** 段階のジョブ（定義にあるものだけ）を、「今すぐ実行」で起動する順に並べる */
export function stageJobs<T extends { id: string; cron: string; after: string[] }>(stage: CycleStage, jobs: readonly T[]): T[] {
  return orderStageJobs(
    jobs.filter((job) => STAGE_JOB[stage](job.id)),
    STAGE_ORDER[stage] ?? [],
  );
}

type StageStatus = CycleView["stages"][number]["status"];

const AWAITING_STATES: readonly CycleItemState[] = ["awaiting_review", "approved"];
/** 準備中・OK 待ち（summary の awaiting） */
const OPEN_STATES: readonly CycleItemState[] = ["preparing", "awaiting_review"];

/** 確かめられなかった項目、または確認の途中で理由が付いている項目（止まっている） */
const isStuck = (item: CycleItem): boolean => item.state === "failed_check" || (item.state === "executed" && item.stateReason !== null);

function emptyView(reason: string): CycleView {
  return {
    cycle: null,
    reason,
    stages: STAGES.map((stage) => ({ stage, status: "not_started", count: 0, jobIds: [] })),
    items: [],
    summary: { proposals: 0, reflected: 0, awaiting: 0, rejected: 0, stuck: 0, keywordReflected: 0 },
    previousVerification: [],
  };
}

/**
 * 段階の状態。
 *   done        項目があり、すべて確認済み（confirmed）か差し戻し済み（rejected）。または項目が無いが、後の段階に項目がある
 *   stuck       確かめられなかった項目・理由つきで executed の項目がある
 *   awaiting    OK 待ち・OK 済み（実行待ち）の項目がある
 *   not_started それ以外
 */
function stageStatus(stage: CycleStage, items: readonly CycleItem[]): StageStatus {
  const own = items.filter((item) => item.stage === stage);
  if (own.length === 0) {
    const later = STAGES.slice(STAGES.indexOf(stage) + 1);
    return items.some((item) => later.includes(item.stage)) ? "done" : "not_started";
  }
  if (own.every((item) => item.state === "confirmed" || item.state === "rejected")) return "done";
  if (own.some(isStuck)) return "stuck";
  if (own.some((item) => AWAITING_STATES.includes(item.state))) return "awaiting";
  return "not_started";
}

function checkActor(actor: string): string {
  const trimmed = actor.trim();
  if (!trimmed) throw new ControlPlaneInputError("操作した人が空");
  if (trimmed.length > ACTOR_MAX_LENGTH) throw new ControlPlaneInputError("操作した人が長すぎる");
  return trimmed;
}

function checkItemId(itemId: string): void {
  if (!ULID_PATTERN.test(itemId)) throw new ControlPlaneInputError("項目の ID が不正");
}

/**
 * article・campaign の記事にアイキャッチ画像が無いか（I6）。無ければ「結び待ちか」（coverPendingFileId がある）、あれば null。
 * campaign の coverUrl が欠けている（この欄を足す前に作った項目）ときも無いとみなす（次の cycle-collect で中身が更新される）
 */
function coverMissing(item: CycleItem): boolean | null {
  const preview = item.preview;
  if (preview.kind !== "article" && preview.kind !== "campaign") return null;
  if (preview.coverUrl) return null;
  return typeof preview.coverPendingFileId === "number";
}

export class CycleService {
  /** 「実行した」の後の確かめ（非同期）の打ち切り用。stop() で打ち切る */
  private readonly confirming = new Set<AbortController>();

  constructor(
    private readonly ctx: EngineContext,
    /** 段階の「今すぐ実行」の進み具合（画面に出す）。無ければ出さない */
    private readonly stageRunner: StageRunner | null = null,
  ) {}

  /** 実行中の確かめを打ち切る（ControlPlane.stop から。冪等） */
  stop(): void {
    for (const controller of this.confirming) controller.abort();
    this.confirming.clear();
  }

  listCycles(): CycleRow[] {
    return this.ctx.cycles.listCycles(LIST_CYCLES_LIMIT);
  }

  async getCycle(cycleId?: CycleId): Promise<CycleView> {
    const { config, cycles } = this.ctx;
    if (cycleId !== undefined && !CYCLE_ID_PATTERN.test(cycleId)) throw new ControlPlaneInputError("周の ID が不正（C-YYYY-MM-DD の形にしてください）");
    if (!config.cycleAnchor) return emptyView("CONTROL_CYCLE_ANCHOR が無い");

    const id = cycleId ?? cycleOf(new Date(), config.cycleAnchor).cycleId;
    const cycle = cycles.getCycle(id);
    if (!cycle) return emptyView(`${id} はまだ開かれていない`);

    const items = cycles.listItems(id);
    // 確認項目を読めなくても画面は出す（承認だけができない。approveCycleItem は同じ理由で拒む）
    let checklists: Checklists | null = null;
    let warning: string | null = null;
    try {
      checklists = await loadChecklists(config.mainCheckout);
    } catch (error) {
      if (!(error instanceof ChecklistError)) throw error;
      warning = `確認項目を読めないため承認できない（${error.message}）`;
      logLine("WARN", "cycle", warning);
    }

    // 手順の「確かめ済みの配信に含まれる記事」は、周をまたいで見る（配信の項目が別の周にあっても手順を出せるように）
    const recent = listRecentItems(cycles);
    const stepsContext = buildStepsContext(config, recent);
    const { jobs } = await this.ctx.loadSchedules();

    return {
      cycle,
      reason: warning,
      stages: STAGES.map((stage) => ({
        stage,
        status: stageStatus(stage, items),
        count: items.filter((item) => item.stage === stage).length,
        jobIds: stageJobs(stage, jobs).map((job) => job.id),
        run: this.stageRunner?.state(stage) ?? null,
      })),
      items: items.map((item) => ({
        ...item,
        checklist: checklists?.[item.kind] ?? [],
        steps: stepsFor(item, stepsContext),
        approvals: cycles.listApprovals(item.itemId),
        strapiAdminUrl: itemStrapiAdminUrl(item, stepsContext),
      })),
      summary: this.summarize(cycle, items, recent),
      previousVerification: await this.previousVerification(cycle, recent),
    };
  }

  /** 画面の上部のまとめ。数えるのは E-13（改修案）の数で、項目の数ではない */
  private summarize(cycle: CycleRow, items: readonly CycleItem[], recent: readonly CycleItem[]): CycleView["summary"] {
    // 改修案から作った項目（proposal の項目は PR の状態を見せるだけ、manual は人の作業なので除く）
    const derived = items.filter((item) => item.proposalId !== null && item.kind !== "manual" && item.kind !== "proposal");
    const proposalsWhere = (predicate: (item: CycleItem) => boolean) => new Set(derived.filter(predicate).map((item) => item.proposalId)).size;
    // 反映は、反映した日が属する周に数える（cycle-close と同じ関数。周をまたいだ反映を含む）
    const reflection = countReflection(recent, cycle);
    return {
      proposals: proposalsWhere(() => true),
      reflected: reflection.reflectedFromProposals,
      awaiting: proposalsWhere((item) => OPEN_STATES.includes(item.state)),
      rejected: proposalsWhere((item) => item.state === "rejected"),
      stuck: proposalsWhere(isStuck),
      keywordReflected: reflection.reflectedFromKeywords,
    };
  }

  /**
   * 前の周に反映した E-13 の判定（verification）。前の周の期間に reflectedAt が入る E-13 のうち、
   * 承認済み main に approved・applied で残っているもの。読めなければ空（画面の他の部分は出す）
   */
  private async previousVerification(cycle: CycleRow, recent: readonly CycleItem[]): Promise<CycleView["previousVerification"]> {
    const { config } = this.ctx;
    if (!config.cycleAnchor) return [];
    const previous = cycleOf(new Date(Date.parse(cycle.startsAt) - DAY_MS), config.cycleAnchor);
    const startsAt = Date.parse(previous.startsAt);
    const endsAt = Date.parse(previous.endsAt);
    const reflected = new Set<string>();
    for (const item of recent) {
      if (!item.proposalId || !item.reflectedAt || item.kind === "manual" || item.kind === "proposal" || item.kind === "deploy") continue;
      const at = Date.parse(item.reflectedAt);
      if (at >= startsAt && at < endsAt) reflected.add(item.proposalId);
    }
    if (reflected.size === 0) return [];
    try {
      return (await readProposals(config.mainCheckout))
        .filter((proposal) => reflected.has(proposal.proposal_id) && ["approved", "applied"].includes(proposal.approval.state))
        .map((proposal) => ({ proposalId: proposal.proposal_id, state: proposal.verification.state, result: proposal.verification.result }));
    } catch (error) {
      logLine("WARN", "cycle", `前の周の判定を読めない（${error instanceof Error ? error.name : "不明"}）`);
      return [];
    }
  }

  /** 項目を読む。無ければ入力の誤り */
  private requireItem(itemId: Ulid): CycleItem {
    checkItemId(itemId);
    const item = this.ctx.cycles.getItem(itemId);
    if (!item) throw new ControlPlaneInputError("項目が見つからない");
    return item;
  }

  async approveCycleItem(itemId: Ulid, checked: string[], actor: string, expectedUpdatedAt: string): Promise<CycleView> {
    const who = checkActor(actor);
    if (!expectedUpdatedAt) throw new ControlPlaneInputError("画面で見た項目の更新時刻（expectedUpdatedAt）が無い");
    const item = this.requireItem(itemId);
    if (item.kind === "proposal") throw new ControlPlaneInputError("改修案の承認は GitHub の PR で行う");
    if (item.preview.kind === "deploy" && item.preview.blocked) {
      throw new ControlPlaneInputError(`配信できない項目は承認できない（${item.preview.blocked}）`);
    }
    // アイキャッチ画像が承認の後に付かないよう、表紙に結ばれるまで承認しない（I6。キャンペーンの記事も同じ）。
    // 結び待ち（coverPendingFileId）のときは、画面に「表紙に結ぶ」の手順が出ている
    const coverPending = coverMissing(item);
    if (coverPending !== null) {
      throw new ControlPlaneInputError(
        `アイキャッチ画像がまだ無い。表紙に結ぶまで待つ${coverPending ? "（画面の手順「表紙に結ぶ」を行い、次の cycle-collect で中身が更新されてから OK を押す）" : ""}`,
      );
    }

    let checklists: Checklists;
    try {
      checklists = await loadChecklists(this.ctx.config.mainCheckout);
    } catch (error) {
      if (error instanceof ChecklistError) throw new ControlPlaneInputError(`確認項目を読めないため承認できない（${error.message}）`);
      throw error;
    }
    // 確認項目は過不足なく入れる（重複・定義に無い id・入れ忘れのどれも承認しない）
    const expected = checklists[item.kind].map((entry) => entry.id);
    const given = new Set(checked);
    if (given.size !== checked.length) throw new ControlPlaneInputError("確認項目の id が重複している");
    const unknown = checked.filter((id) => !expected.includes(id));
    if (unknown.length > 0) throw new ControlPlaneInputError("定義に無い確認項目が含まれている");
    const missing = expected.filter((id) => !given.has(id));
    if (missing.length > 0) throw new ControlPlaneInputError(`確認項目が足りない（残り ${missing.length} 件）`);

    // 配信は最新の deploy の項目だけを承認する（古い項目の dist を配ると、その後に公開した記事を --delete で消すため。Ruling 31）。
    // ここから遷移までは await を挟まない（published-article-check の項目の作成と入れ違わないように）
    if (item.kind === "deploy") {
      const latest = this.ctx.cycles.latestItemOfKind("deploy");
      if (latest && latest.itemId !== item.itemId) {
        throw new ControlPlaneInputError(`新しい配信の項目（${latest.title}）がある。最新の deploy の項目だけを承認できる（画面を読み込み直してください）`);
      }
    }
    // OK は、人が画面で見た内容（expectedUpdatedAt）のままのときだけ通す（確認項目を入れた後に本文が差し替えられた項目を承認しない）。
    // 遷移と承認の記録は 1 つのトランザクション
    const approved = this.ctx.cycles.transitionWithApproval(
      item.itemId,
      ["awaiting_review"],
      "approved",
      null,
      { itemId: item.itemId, action: "approve", actor: who, checked: expected, reason: null, at: toIsoJst() },
      expectedUpdatedAt,
    );
    if (!approved) {
      const current = this.ctx.cycles.getItem(item.itemId);
      if (current?.state === "awaiting_review") throw new ControlPlaneInputError("項目が更新された。画面を読み込み直して確かめる");
      throw new ControlPlaneInputError("この項目は OK を押せる状態ではない（OK 待ちでない。画面を読み込み直してください）");
    }
    return this.getCycle(item.cycleId);
  }

  async rejectCycleItem(itemId: Ulid, reason: string, actor: string): Promise<CycleView> {
    const who = checkActor(actor);
    const trimmed = reason.trim();
    if (!trimmed) throw new ControlPlaneInputError("差し戻しの理由が空");
    if (trimmed.length > REJECT_REASON_MAX_LENGTH) throw new ControlPlaneInputError(`差し戻しの理由は ${REJECT_REASON_MAX_LENGTH} 文字までにしてください`);
    const item = this.requireItem(itemId);
    // 改修案の項目は PR の状態（却下・閉じた）で rejected になる。画面から差し戻すと PR の状態とずれる
    if (item.kind === "proposal") throw new ControlPlaneInputError("改修案の差し戻しは GitHub の PR で行う");

    // 理由は次の周のエージェントが docs/cycles/ 経由で読むので、メール・電話番号の形は伏せ字にして保存する
    const saved = redactSummary(trimmed).text;
    // 準備中（作用のジョブが止まった・中身を作れない）の項目も差し戻せる（I2）。差し戻した E-13 は作用のジョブに選び直されない
    const rejected = this.ctx.cycles.transitionWithApproval(
      item.itemId,
      ["preparing", "awaiting_review", "approved", "failed_check"],
      "rejected",
      saved,
      { itemId: item.itemId, action: "reject", actor: who, checked: [], reason: saved, at: toIsoJst() },
    );
    if (!rejected) throw new ControlPlaneInputError("この項目は差し戻せる状態ではない（画面を読み込み直してください）");
    // 人が差し戻した配信の項目の、項目ごとのスナップショットを消す（残り続けないように。P3。確かめた配信のスナップショットは変えない）
    if (item.kind === "deploy") this.ctx.kv.delete(itemSnapshotKey(item.sourceRef));
    return this.getCycle(item.cycleId);
  }

  async markCycleItemExecuted(itemId: Ulid, actor: string): Promise<{ accepted: boolean }> {
    const who = checkActor(actor);
    const item = this.requireItem(itemId);
    if (item.kind === "proposal") throw new ControlPlaneInputError("改修案は GitHub の PR の承認とマージで進む（実行した、は押せない）");
    // 作用のジョブが止まって failed_check になった項目（中身が無い）は、実行するものが無い。差し戻す
    if (item.preview.kind === "pending") throw new ControlPlaneInputError("中身がまだ無い項目は「実行した」を押せない（差し戻す）");
    const executed = this.ctx.cycles.transitionWithApproval(
      item.itemId,
      ["approved", "failed_check"],
      "executed",
      null,
      { itemId: item.itemId, action: "execute", actor: who, checked: [], reason: null, at: toIsoJst() },
    );
    if (!executed) {
      throw new ControlPlaneInputError("この項目は「実行した」を押せる状態ではない（OK 済みか、確かめられなかった項目だけ）");
    }
    this.confirmInBackground(item.itemId);
    return { accepted: true };
  }

  /** 実行した項目の確かめを、画面の応答を待たせずに始める。失敗は E-15 ではなくログに残す（項目は executed のまま、次の cycle-collect が確かめ直す） */
  private confirmInBackground(itemId: Ulid): void {
    const controller = new AbortController();
    this.confirming.add(controller);
    const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    timer.unref();
    void (async () => {
      const item = this.ctx.cycles.getItem(itemId);
      if (!item) return;
      await confirmExecutedItem(this.ctx, item, buildConfirmDeps(this.ctx, controller.signal));
    })()
      .catch((error: unknown) => logLine("WARN", "cycle", `実行した項目の確かめに失敗した（${error instanceof Error ? error.name : "不明"}）`))
      .finally(() => {
        clearTimeout(timer);
        this.confirming.delete(controller);
      });
  }

  /**
   * 今日の周を手動で開く（0 日目以外なら manual: true）。既にあれば何もしない（openCycle は冪等で、定期実行の cycle-open が先に開いていてもそのまま）。
   * 画面から作業場の git の同期（cycle-open の syncWorktree）は行わない。行を作るだけで足り、同期は定期実行の cycle-open が担う。
   * 期間が終わった周を閉じるのも cycle-collect（毎日の最初）・cycle-close に任せる。
   */
  async startCycle(actor: string): Promise<CycleView> {
    checkActor(actor);
    const { config, cycles } = this.ctx;
    if (!config.cycleAnchor) throw new ControlPlaneInputError("CONTROL_CYCLE_ANCHOR が無いため周を開けない");
    const now = cycleOf(new Date(), config.cycleAnchor);
    // 定期実行の cycle-open と同じく、manual は「起点の日（0 日目）以外に手で開いた」ことの印
    cycles.openCycle(now.cycleId, now.startsAt, now.endsAt, now.day !== 0);
    logLine("INFO", "cycle", `${now.cycleId} を画面から開いた（周の ${now.day + 1} / ${CYCLE_LENGTH_DAYS} 日目）`);
    return this.getCycle(now.cycleId);
  }
}
