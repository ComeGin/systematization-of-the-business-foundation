// 反映の数え方（spec 5.10・5.11 の 2）。
// - 反映は「公開サイトに出た（配信・送信が確かめられた）」こと。数えるのは reflectedAt が周の期間に入る項目で、起票した周ではない。
// - article（E-13 由来もキーワード由来も）と code は、確かめ済み（confirmed）の deploy に含まれたときに反映済み。
//     article: deploy の changes に記事の URL があり、その deploy が確認した下書き（preview の draftUpdatedAt。Ruling 35）の後に作られ、
//              かつ、その deploy の項目ごとのスナップショット（kv）にある該当記事の publishedAt が、その下書き以後（P7。書き直しの記事で
//              旧版の URL が未確認の deploy の changes に残っていても、書き直した版の公開前の配信は数えない。読めないときは数えない）
//     code:    PR のマージのコミットが、deploy のコミットに含まれる（GitHub のコミットの比較で確かめる。祖先か同じ）
//   reflectedAt は、その deploy を確かめた時刻（deploy の項目の updatedAt）。
// - campaign は送信の確認（confirmed）の時点で反映済み（confirm.ts が記録する）。
// - manual（config_change）と proposal は数えない。
import type { CycleCloseResult, CycleItem, CycleRow } from "../contract.js";
import { SNAPSHOT_KEY, itemSnapshotKey, parseSnapshot } from "../builtin/published-article-check.js";
import type { GitHubClient } from "../integrations/github.js";
import type { CycleStore } from "../store/cycles.js";
import type { KvStore } from "../store/kv.js";
import { BASE_TIME_TOLERANCE_MS, articleBaseTime, isAtOrAfterBase, itemArticleUrl } from "./urls.js";

/** 反映と止まっている場所を見る周の数（今の周を含む。周をまたいで進む項目を取りこぼさないため） */
export const RECENT_CYCLES = 6;

/** 新しい周から RECENT_CYCLES 件の項目すべて */
export function listRecentItems(cycles: CycleStore, count: number = RECENT_CYCLES): CycleItem[] {
  return cycles.listCycles(count).flatMap((cycle) => cycles.listItems(cycle.cycleId));
}

const inPeriod = (at: string, cycle: Pick<CycleRow, "startsAt" | "endsAt">): boolean => {
  const t = Date.parse(at);
  return t >= Date.parse(cycle.startsAt) && t < Date.parse(cycle.endsAt);
};

/**
 * 周の反映の件数と、止まっている場所の内訳。items はどの周の項目を含んでもよい（周をまたいだ反映を数えるため）。
 * - reflectedFromProposals: reflectedAt が周の期間にある、E-13 由来（proposalId あり）の項目の E-13 の数
 * - reflectedFromKeywords:  同じく、キーワード由来（proposalId なし）の article の数
 * - stuck: 周の終わりより前に作られ、まだ反映も差し戻しもされていない項目の止まっている場所
 *     no_proposal       この周に作られた、E-13 に結びつく項目（改修案・作用の項目）が 1 つも無い（1 か 0）
 *     pr_not_approved   PR が承認・マージされていない改修案
 *     awaiting_review   中身の準備中か、OK 待ち
 *     not_executed      OK の後に実行されていないか、確かめられなかった（failed_check）
 *     not_deployed      確かめたが、まだ配信に含まれていない article・code
 */
export function countReflection(items: readonly CycleItem[], cycle: CycleRow): CycleCloseResult {
  const reflectedProposals = new Set<string>();
  let reflectedFromKeywords = 0;
  for (const item of items) {
    if (item.kind === "manual" || item.kind === "proposal" || item.kind === "deploy") continue;
    if (!item.reflectedAt || !inPeriod(item.reflectedAt, cycle)) continue;
    if (item.proposalId) reflectedProposals.add(item.proposalId);
    else if (item.kind === "article") reflectedFromKeywords++;
  }

  const stuck: CycleCloseResult["stuck"] = { no_proposal: 0, pr_not_approved: 0, awaiting_review: 0, not_executed: 0, not_deployed: 0 };
  const endsAt = Date.parse(cycle.endsAt);
  let proposalsInCycle = 0;
  for (const item of items) {
    if (item.kind === "manual" || item.kind === "deploy") continue;
    if (item.cycleId === cycle.cycleId && (item.kind === "proposal" || item.proposalId)) proposalsInCycle++;
    if (Date.parse(item.createdAt) >= endsAt || item.reflectedAt || item.state === "rejected") continue;
    if (item.kind === "proposal") {
      if (item.state === "preparing" || item.state === "awaiting_review") stuck.pr_not_approved++;
      continue;
    }
    switch (item.state) {
      case "preparing":
      case "awaiting_review":
        stuck.awaiting_review++;
        break;
      case "approved":
      case "executed":
      case "failed_check":
        stuck.not_executed++;
        break;
      case "confirmed":
        stuck.not_deployed++;
        break;
    }
  }
  if (proposalsInCycle === 0) stuck.no_proposal = 1;

  return { reflectedFromProposals: reflectedProposals.size, reflectedFromKeywords, stuck };
}

/** 確かめ済みの deploy（確かめた順） */
function confirmedDeploys(items: readonly CycleItem[]): CycleItem[] {
  return items
    .filter((item) => item.kind === "deploy" && item.state === "confirmed" && item.preview.kind === "deploy")
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

export interface ReflectionDeps {
  /** deploy の項目ごとのスナップショット・確かめた配信のスナップショットを読む（P7） */
  kv: Pick<KvStore, "get">;
  siteUrl: string | null;
  github: GitHubClient | null;
  issueNumber: number | null;
}

/**
 * 確かめ済みで未反映の article・code に、含まれた deploy を探して reflectedAt を記録する。
 * 戻り値は deploy の項目 ID → その deploy で反映済みにした E-13 の proposal_id（deploy の手順に applied_at の記録を出すため）。
 * GitHub が無ければ code は反映を記録しない（次の実行で確かめ直す）。外部の失敗は例外として呼び出し側に返す。
 */
export async function markReflections(
  cycles: CycleStore,
  items: readonly CycleItem[],
  deps: ReflectionDeps,
): Promise<Map<string, string[]>> {
  const deploys = confirmedDeploys(items);
  const lastConfirmed = deploys.at(-1);
  /**
   * deploy の項目を作った時点の、公開済みの記事の一覧。項目ごとのスナップショット（確かめる前）か、
   * 最後に確かめた配信なら確かめた配信のスナップショット（確認が項目のものを写して消す）。どちらも無ければ null
   */
  const snapshotOf = (deploy: CycleItem): ReturnType<typeof parseSnapshot> => {
    const raw = deps.kv.get(itemSnapshotKey(deploy.sourceRef)) ?? (deploy === lastConfirmed ? deps.kv.get(SNAPSHOT_KEY) : null);
    return parseSnapshot(raw);
  };
  const byDeploy = new Map<string, string[]>();
  const record = (item: CycleItem, deploy: CycleItem) => {
    cycles.setReflected(item.itemId, deploy.updatedAt);
    if (item.proposalId) byDeploy.set(deploy.itemId, [...(byDeploy.get(deploy.itemId) ?? []), item.proposalId]);
  };

  for (const item of items) {
    if (item.state !== "confirmed" || item.reflectedAt) continue;
    // 配信は項目を取り込んだ後のものだけを見る（書き直しの前の公開を含む、古い配信で反映済みにしない）。
    // article の基準は確認した下書きの updatedAt（Ruling 35。集約より前に公開・配信した記事も数える）、それ以外は項目の createdAt
    // 基準との比較には許容幅を入れる（P6。確認の BASE_TIME_TOLERANCE_MS と同じ）
    const baseTime = articleBaseTime(item);
    const base = Date.parse(baseTime) - BASE_TIME_TOLERANCE_MS;
    const candidates = deploys.filter((deploy) => Date.parse(deploy.createdAt) >= base);
    if (item.kind === "article") {
      const url = itemArticleUrl(item, deps.siteUrl);
      const documentId = item.preview.kind === "article" ? item.preview.documentId : null;
      // 書き直しの記事は、その deploy を作った時点で、書き直した版が公開済みだったものだけを数える（スナップショットが読めなければ数えない）
      const includesRewrite = (deploy: CycleItem): boolean => {
        const entry = snapshotOf(deploy)?.find((article) => article.documentId === documentId);
        return entry !== undefined && isAtOrAfterBase(entry.publishedAt, baseTime);
      };
      const deploy =
        url && documentId
          ? candidates.find((d) => d.preview.kind === "deploy" && d.preview.changes.includes(url) && includesRewrite(d))
          : undefined;
      if (deploy) record(item, deploy);
    } else if (item.kind === "code" && item.preview.kind === "code" && deps.github && deps.issueNumber !== null && candidates.length > 0) {
      const number = await deps.github.findPullRequest(`${deps.issueNumber}-feature-${item.preview.proposalId}`);
      const pull = number === null ? null : await deps.github.getPullRequest(number);
      if (!pull?.mergeCommitSha) continue;
      for (const deploy of candidates) {
        if (deploy.preview.kind === "deploy" && (await deps.github.isAncestor(pull.mergeCommitSha, deploy.preview.commitSha))) {
          record(item, deploy);
          break;
        }
      }
    }
  }
  return byDeploy;
}
