// 承認済みの E-13 の選択と、項目の種類への対応（改善ループ。spec 5.9）。
// どの E-13 を作用のジョブに渡すかはエンジンが決める。エージェントには選ばせない（取得の範囲を定義に固定する ADR-05 の理由）。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROPOSALS_DIR } from "../constants/paths.js";
import type { CycleItemKind, CycleStage, ProposalKind } from "../contract.js";
import { type Proposal, parseProposal } from "../definitions/proposal.js";
import { logLine } from "../log.js";

const PROPOSAL_FILE = /^PRP-\d{4}-\d{4}\.md$/;

/**
 * 承認済み（approval.state が approved）の E-13。proposal_id の昇順。
 * 読み先は承認済み main のチェックアウト（作業ツリーからは読まない。ADR-18）。
 * 読めないファイルは WARN（ファイル名と理由だけ）で飛ばす。
 */
export async function listApprovedProposals(mainCheckout: string): Promise<Proposal[]> {
  return (await readProposals(mainCheckout)).filter((proposal) => proposal.approval.state === "approved");
}

/**
 * チェックアウト（main か作業ツリー）の docs/proposals の E-13 すべて（状態を問わない）。proposal_id の昇順。
 * 読めないファイル・ファイル名と proposal_id が違うものは WARN（ファイル名と理由だけ）で飛ばす。
 */
export async function readProposals(checkout: string): Promise<Proposal[]> {
  const dir = join(checkout, PROPOSALS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => PROPOSAL_FILE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const proposals: Proposal[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(dir, name), "utf8");
    } catch (error) {
      logLine("WARN", "proposals", `${name} を読めないので飛ばす: ${error instanceof Error ? error.name : "不明"}`);
      continue;
    }
    const parsed = parseProposal(text);
    if (!parsed.ok) {
      logLine("WARN", "proposals", `${name} を E-13 として読めないので飛ばす: ${parsed.reason}`);
      continue;
    }
    if (`${parsed.value.proposal_id}.md` !== name) {
      logLine("WARN", "proposals", `${name} の proposal_id がファイル名と一致しないので飛ばす`);
      continue;
    }
    proposals.push(parsed.value);
  }
  return proposals.sort((a, b) => (a.proposal_id < b.proposal_id ? -1 : a.proposal_id > b.proposal_id ? 1 : 0));
}

/**
 * 次に作用させる E-13。kinds に含まれる種類のうち、項目がまだ無い（taken に無い）最も古い proposal_id。
 * taken は項目の proposalId の集合（どの周のものも含む。前の周で作用させた E-13 を選び直さない）。
 */
export function pickNextProposal(proposals: Proposal[], kinds: ProposalKind[], taken: Set<string>): Proposal | null {
  const candidates = proposals
    .filter((proposal) => proposal.approval.state === "approved")
    .filter((proposal) => kinds.includes(proposal.change.kind))
    .filter((proposal) => !taken.has(proposal.proposal_id))
    .sort((a, b) => (a.proposal_id < b.proposal_id ? -1 : a.proposal_id > b.proposal_id ? 1 : 0));
  return candidates[0] ?? null;
}

/** change.kind から、作る項目の種類と段階を決める。項目を作らない種類（config_change・experiment_start）は null */
export function itemShapeOf(kind: ProposalKind): { kind: CycleItemKind; stage: CycleStage } | null {
  switch (kind) {
    case "content_rewrite":
      return { kind: "article", stage: "draft" };
    case "email_campaign":
      return { kind: "campaign", stage: "draft" };
    case "technical_seo":
    case "accessibility":
    case "cta_swap":
    case "internal_link":
      return { kind: "code", stage: "evaluate" };
    case "experiment_start":
    case "config_change":
      return null;
  }
}
