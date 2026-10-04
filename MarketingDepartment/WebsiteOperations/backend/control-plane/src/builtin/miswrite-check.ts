// 誤った書き込みの突き合わせ（TA-07 の 6.2、DD-07 の 4.1）。
// エージェント専用ユーザーが送ったメッセージのうち、どの E-13 にも E-15 にも対応しないものを「候補」にする。
// メッセージの本文は読み捨てて保存しない（ID・時刻・理由だけ）。
//
// 照合の規則（仮置き。TA-07・DD-07 は「対応する」の定義を決めていない。README にも書いてある）:
//   (a) 承認された提案: CONTROL_MAIN_CHECKOUT の docs/proposals/*.md のうち approval.state が approved / applied で、
//       target.identifier / also_affects に `display_id=<n>` を含み、メッセージの送信時刻が created_at 以降のもの。
//       作業ツリーの未承認の書き換えで「対応あり」にされないよう、main から読む。
//   (b) 実行の記録: 送信時刻が重なる E-15 の run の targetIds に `chatwoot-conversation:<n>` があるもの。
// 拾えるのは送信だけで、会話の属性（担当者・ラベル・状態）の変更は拾えない（TA-07 の 6.2）。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROPOSALS_DIR } from "../constants/paths.js";
import type { BuiltinHandler } from "../context.js";
import type { MiswriteCandidate, RunRecord } from "../contract.js";
import { type Proposal, parseProposal } from "../definitions/proposal.js";
import { ChatwootReader } from "../integrations/chatwoot.js";
import { IntegrationError } from "../integrations/http.js";
import { logLine } from "../log.js";
import { toIsoJst } from "../time.js";

const CURSOR_KEY = "miswrite.cursor";
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 前回の境目での取りこぼしを防ぐ重なり */
const OVERLAP_MS = 5 * 60 * 1000;
/** 実行の時刻との照合で許す前後のずれ */
const RUN_MARGIN_MS = 60 * 1000;
const MAX_CONVERSATION_PAGES = 40;
const MAX_MESSAGE_PAGES = 10;
export const CONVERSATION_TARGET_PREFIX = "chatwoot-conversation:";

const PROPOSAL_FILE = /^PRP-\d{4}-\d{4}\.md$/;

interface ApprovedProposal {
  createdAtMs: number;
  displayIds: Set<number>;
}

function displayIdsOf(proposal: Proposal): Set<number> {
  const ids = new Set<number>();
  for (const text of [proposal.target.identifier, ...proposal.target.also_affects]) {
    for (const match of text.matchAll(/display_id\s*[=:]\s*(\d+)/g)) ids.add(Number(match[1]));
  }
  return ids;
}

async function loadApprovedProposals(mainCheckout: string): Promise<ApprovedProposal[]> {
  const dir = join(mainCheckout, PROPOSALS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => PROPOSAL_FILE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: ApprovedProposal[] = [];
  for (const name of names) {
    const parsed = parseProposal(await readFile(join(dir, name), "utf8"));
    if (!parsed.ok) continue;
    const proposal = parsed.value;
    if (proposal.approval.state !== "approved" && proposal.approval.state !== "applied") continue;
    const displayIds = displayIdsOf(proposal);
    if (displayIds.size === 0) continue;
    result.push({ createdAtMs: Date.parse(proposal.created_at) || 0, displayIds });
  }
  return result;
}

function overlaps(run: RunRecord, sentMs: number, nowMs: number): boolean {
  const start = Date.parse(run.startedAt) - RUN_MARGIN_MS;
  const end = (run.finishedAt ? Date.parse(run.finishedAt) : nowMs) + RUN_MARGIN_MS;
  return sentMs >= start && sentMs <= end;
}

function conversationIdsOf(run: RunRecord): number[] {
  return run.targetIds
    .filter((id) => id.startsWith(CONVERSATION_TARGET_PREFIX))
    .map((id) => Number(id.slice(CONVERSATION_TARGET_PREFIX.length)))
    .filter(Number.isInteger);
}

export const miswriteCheck: BuiltinHandler = async ({ ctx, runId, signal }) => {
  const config = ctx.config.miswrite;
  if (!config) throw new Error("突き合わせの設定が無い");
  const reader = new ChatwootReader(config, signal);

  const startedAt = new Date();
  const cursor = ctx.kv.get(CURSOR_KEY);
  const sinceMs = (cursor ? Date.parse(cursor) : startedAt.getTime() - FIRST_WINDOW_MS) - OVERLAP_MS;

  const proposals = await loadApprovedProposals(ctx.config.mainCheckout);
  // 自分自身の実行は照合の材料にしない
  const runs = ctx.runs
    .startedSince(toIsoJst(new Date(sinceMs - 60 * 60 * 1000)))
    .filter((run) => run.runId !== runId && run.agentName !== null);

  let scannedConversations = 0;
  let agentMessages = 0;
  let truncated = false;
  const found: MiswriteCandidate[] = [];

  try {
    for (let page = 1; page <= MAX_CONVERSATION_PAGES && !signal.aborted; page++) {
      const conversations = await reader.conversationsPage(page);
      if (conversations.length === 0) break;
      let anyRecent = false;
      for (const conversation of conversations) {
        if (conversation.lastActivityMs !== null && conversation.lastActivityMs < sinceMs) continue;
        anyRecent = true;
        scannedConversations++;

        let before: number | undefined;
        for (let messagePage = 0; messagePage < MAX_MESSAGE_PAGES; messagePage++) {
          const messages = await reader.messages(conversation.displayId, before);
          if (messages.length === 0) break;
          for (const message of messages) {
            if (message.createdAtMs < sinceMs) continue;
            if (message.messageType !== 1 || message.senderType !== "user" || message.senderId !== config.agentUserId) {
              continue;
            }
            agentMessages++;
            const corresponds =
              proposals.some((p) => p.displayIds.has(conversation.displayId) && p.createdAtMs <= message.createdAtMs) ||
              runs.some(
                (run) =>
                  overlaps(run, message.createdAtMs, startedAt.getTime()) &&
                  conversationIdsOf(run).includes(conversation.displayId),
              );
            if (corresponds) continue;
            const nearest = runs.filter((run) => overlaps(run, message.createdAtMs, startedAt.getTime())).at(-1);
            found.push({
              conversationDisplayId: conversation.displayId,
              messageId: message.id,
              sentAt: toIsoJst(new Date(message.createdAtMs)),
              nearestRunId: nearest?.runId ?? null,
              reason: "no matching proposal or run",
            });
          }
          const oldest = messages[messages.length - 1]!;
          if (oldest.createdAtMs < sinceMs || messages.length < 20) break;
          before = oldest.id;
          if (messagePage === MAX_MESSAGE_PAGES - 1) truncated = true;
        }
      }
      if (!anyRecent) break; // 更新の新しい順なので、これより後ろはすべて範囲の外
      if (page === MAX_CONVERSATION_PAGES) truncated = true;
    }
  } catch (error) {
    if (error instanceof IntegrationError) {
      logLine("ERROR", "miswrite", error.message, runId);
      return {
        outcome: "failure",
        summary: `誤った書き込みの突き合わせに失敗した（${error.failureClass}）`,
        targetIds: [],
        failureClass: error.failureClass,
      };
    }
    throw error;
  }

  const foundAt = toIsoJst();
  const added = found.filter((candidate) => ctx.miswrite.add(candidate, foundAt));
  if (!truncated && !signal.aborted) ctx.kv.set(CURSOR_KEY, startedAt.toISOString());

  return {
    outcome: truncated ? "partial" : "success",
    summary: `突き合わせ: 走査した会話 ${scannedConversations} 件、エージェントの送信 ${agentMessages} 件、候補 ${found.length} 件（新規 ${added.length} 件）${
      truncated ? "。走査の上限に達したため一部を確認できていない" : ""
    }`,
    targetIds: [...new Set(added.map((c) => `${CONVERSATION_TARGET_PREFIX}${c.conversationDisplayId}`))].slice(0, 100),
    failureClass: truncated ? "truncated" : null,
  };
};
