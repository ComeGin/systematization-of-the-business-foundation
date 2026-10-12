import type { ChatwootClient } from "../chatwoot/client.js";
import type { EventTarget, WelcomeEvent } from "../chatwoot/events.js";
import type { LastMessage, Reply } from "../chatwoot/types.js";
import { LABELS, MESSAGE_TYPE_OUTGOING, MESSAGE_TYPE_TEMPLATE } from "../constants.js";
import type { Action } from "./decide.js";

export type Outcome = "done" | "not-pending" | "stale";

export interface ExecuteResult {
  readonly outcome: Outcome;
  readonly sent: boolean;
}

/**
 * 判定を Chatwoot に反映する（仕様 7.4）。送信の要否は会話の last_non_activity_message で決める:
 *   - 対象のメッセージがまだ最新（その後に Chatwoot の自動のテンプレートしか無い場合を含む）→ 1 通送る
 *   - 対象より新しいボットの outgoing があれば、その in_reply_to（ボットは返事に必ず入れる）で見分ける:
 *       - 対象への返事 → 送信は済んでいる（Chatwoot の送り直し）。ラベルとステータスだけやり直す
 *       - 対象より前の発言への返事 → 対象にはまだ答えていない（続けて送られた質問の競合）。1 通送る
 *       - 対象より後の発言への返事・in_reply_to が無い → 古いイベント（古い選択肢を後から押した、など）。何もしない
 *   - それ以外（訪問者がその後に発言した、など）→ 古いイベント。新しい発言はそのイベントで扱う
 * ラベル（付け替え）とステータスは冪等。どこかで失敗したら例外にする（仕様 8 節）
 */
function shouldSend(last: LastMessage | null, targetId: number): boolean | "stale" {
  if (!last) return "stale";
  if (last.id === targetId) return true;
  if (last.id < targetId) return "stale";
  // Chatwoot が自動で足したテンプレート（最初の発言の直後の連絡先の入力欄）は、訪問者の新しい発言ではない
  if (last.messageType === MESSAGE_TYPE_TEMPLATE) return true;
  if (last.messageType !== MESSAGE_TYPE_OUTGOING || last.senderType !== "agent_bot" || last.inReplyTo === null) return "stale";
  if (last.inReplyTo === targetId) return false;
  return last.inReplyTo < targetId ? true : "stale";
}

export async function execute(
  client: ChatwootClient,
  target: Pick<EventTarget, "conversationId" | "messageId">,
  action: Action,
): Promise<ExecuteResult> {
  const view = await client.getConversation(target.conversationId);
  // ［解決しました］だけは、担当者の会話（open・snoozed）でも受け付ける（2026-10-12 の解決の確認の仕様 3 節）。ほかは pending のときだけ
  const resolvingAgentOwned = action.decision === "resolved" && (view.status === "open" || view.status === "snoozed");
  if (view.status !== "pending" && !resolvingAgentOwned) return { outcome: "not-pending", sent: false };

  const send = shouldSend(view.lastMessage, target.messageId);
  if (send === "stale") return { outcome: "stale", sent: false };
  // 担当者の会話では、ボタン自身が最新のときだけ閉じる。ボタンへのボットの返事（引き継ぎの案内など）が後にあれば、お礼なしに閉じない。
  // テンプレートも例外にしない（訪問者の新しい発言に営業時間外の自動返信が続いた後に、未回答の質問ごと閉じないため。2026-10-12 の最終レビュー）
  if (resolvingAgentOwned && view.lastMessage?.id !== target.messageId) return { outcome: "stale", sent: false };

  if (send) await client.sendMessage(target.conversationId, action.reply, target.messageId);
  if (action.addLabels.some((label) => !view.labels.includes(label))) {
    // 付け替えは一覧ごと書くので、書く直前に読み直す。送信の間に担当者のマクロなどが足したラベルを消さない（2026-10-12 の最終レビュー）
    const current = await client.getLabels(target.conversationId);
    const missing = action.addLabels.filter((label) => !current.includes(label));
    if (missing.length > 0) await client.setLabels(target.conversationId, [...current, ...missing]);
  }
  if (action.status) await client.setStatus(target.conversationId, action.status);
  return { outcome: "done", sent: send };
}

export interface WelcomeResult {
  readonly outcome: "sent" | "not-pending";
  readonly conversationId: number;
}

/**
 * ウィジェットを開いた訪問者の会話を作り、一覧を 1 通送る（2026-10-12 の仕様 3 節の 5・6）。
 * 作成の応答が pending でなければ送らない（受信箱が lock_to_single_conversation だと、既存の解決済みの会話が返る。
 * そこに一覧を出しても、pending でないため選択に答えられない）。失敗は例外（仕様 5 節）
 */
export async function executeWelcome(client: ChatwootClient, target: Pick<WelcomeEvent, "sourceId" | "inboxId">, reply: Reply): Promise<WelcomeResult> {
  const created = await client.createConversation(target.sourceId, target.inboxId);
  if (created.status !== "pending") return { outcome: "not-pending", conversationId: created.id };
  await client.sendMessage(created.id, reply, null);
  return { outcome: "sent", conversationId: created.id };
}

export type AskResolvedOutcome = "sent" | "skip-resolved" | "skip-no-label";

/**
 * 担当者のマクロ「解決の確認を送る」（ラベル faq-ask-resolved）への応答（2026-10-12 の解決の確認の仕様 3 節の 4〜6）。
 * 会話を読み直し、解決済みなら何もしない。ラベルがまだあれば、送る前に外す（二度押し・重複したイベントで 2 通出さないため）。失敗は例外
 */
export async function executeAskResolved(client: ChatwootClient, conversationId: number, reply: Reply): Promise<AskResolvedOutcome> {
  const view = await client.getConversation(conversationId);
  if (view.status === "resolved") return "skip-resolved";
  if (!view.labels.includes(LABELS.askResolved)) return "skip-no-label";
  await client.setLabels(conversationId, view.labels.filter((label) => label !== LABELS.askResolved));
  await client.sendMessage(conversationId, reply, null);
  return "sent";
}
