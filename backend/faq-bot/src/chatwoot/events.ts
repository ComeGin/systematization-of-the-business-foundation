import * as z from "zod/v4";
import { LABELS, MAX_QUESTION_CHARS } from "../constants.js";
import type { ConversationStatus } from "./types.js";

// Message#webhook_data の必要な部分だけ（他の項目は無視する）。conversation.id は display_id
const MessagePayload = z.object({
  event: z.enum(["message_created", "message_updated"]),
  id: z.number().int().positive(),
  content: z.string().nullish(),
  message_type: z.string(),
  content_type: z.string().nullish(),
  content_attributes: z
    .object({ submitted_values: z.array(z.object({ value: z.string().min(1).max(100) }).passthrough()).nullish() })
    .passthrough()
    .nullish(),
  private: z.boolean().nullish(),
  sender: z.object({ type: z.string().nullish() }).passthrough().nullish(),
  account: z.object({ id: z.number().int().positive() }).passthrough(),
  conversation: z.object({ id: z.number().int().positive() }).passthrough(),
});

// ContactInbox#webhook_data（webwidget_triggered）の必要な部分だけ。current_conversation は会話の EventDataPresenter#webhook_data
// current_conversation は nullable（null は「会話なし」）で、キーが無い本文は壊れたものとして 400 にする
// （本文の形が変わったときに、開くたびに会話を作る方向へ倒れないため。2026-10-12 の最終レビュー）
const WelcomePayload = z.object({
  id: z.number().int().positive(),
  source_id: z.string().min(1),
  inbox: z.object({ id: z.number().int().positive() }).passthrough(),
  account: z.object({ id: z.number().int().positive() }).passthrough(),
  current_conversation: z
    .object({ status: z.enum(["open", "resolved", "pending", "snoozed"]) })
    .passthrough()
    .nullable(),
});

// 会話の webhook_data（conversation_updated）の必要な部分だけ。id は display_id。
// changed_attributes は Chatwoot の BaseListener#extract_changed_attributes の形（[{ 属性名: { previous_value, current_value } }]。変更が無ければ null）
const ConversationUpdatedPayload = z.object({
  id: z.number().int().positive(),
  account: z.object({ id: z.number().int().positive() }).passthrough(),
  changed_attributes: z.array(z.record(z.string(), z.unknown())).nullish(),
});
const LabelListChange = z.object({
  previous_value: z.array(z.string()).nullish(),
  current_value: z.array(z.string()).nullish(),
});

export interface EventTarget {
  readonly accountId: number;
  readonly conversationId: number;
  readonly messageId: number;
}

export interface QuestionEvent extends EventTarget {
  readonly kind: "question";
  readonly text: string;
}

export interface SelectionEvent extends EventTarget {
  readonly kind: "selection";
  readonly value: string;
}

/** 訪問者がウィジェットを開いた（webwidget_triggered。会話はまだ無いか、直前の会話がある） */
export interface WelcomeEvent {
  readonly kind: "welcome";
  readonly accountId: number;
  readonly inboxId: number;
  /** ContactInbox の内部の id（本文の id）。ログで同じ訪問者の開閉を追うのに使う（source_id と違い、外から訪問者になりすませない値） */
  readonly contactInboxId: number;
  readonly sourceId: string;
  /** その訪問者のこの受信箱の最後の会話のステータス（会話が無ければ null） */
  readonly currentStatus: ConversationStatus | null;
}

/** 担当者がラベル faq-ask-resolved を付けた（マクロ「解決の確認を送る」）。ボットが［解決しました］ボタンを送る */
export interface AskResolvedEvent {
  readonly kind: "ask-resolved";
  readonly accountId: number;
  /** display_id */
  readonly conversationId: number;
}

export type BotEvent = QuestionEvent | SelectionEvent | WelcomeEvent | AskResolvedEvent | { readonly kind: "ignore"; readonly reason: string };

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

const ignore = (reason: string): BotEvent => ({ kind: "ignore", reason });

function parseWelcome(body: unknown): WelcomeEvent {
  const parsed = WelcomePayload.safeParse(body);
  if (!parsed.success) throw new InvalidEventError(`形式が違う（${parsed.error.issues[0]?.path.join(".") || "root"}）`);
  return {
    kind: "welcome",
    accountId: parsed.data.account.id,
    inboxId: parsed.data.inbox.id,
    contactInboxId: parsed.data.id,
    sourceId: parsed.data.source_id,
    currentStatus: parsed.data.current_conversation?.status ?? null,
  };
}

/**
 * この更新でラベル faq-ask-resolved が今付いたとき（前の値に無く、今の値にある）だけ ask-resolved（2026-10-12 のユーザーの決定）。
 * ほかの更新（ステータス・担当・ボットのラベル・既に付いているラベル）は API を呼ばずに ignore。
 * 残ったラベルで、後の別の更新や解決済みの会話の開き直しのときにボタンを出さないため
 */
function parseConversationUpdated(body: unknown): BotEvent {
  const parsed = ConversationUpdatedPayload.safeParse(body);
  if (!parsed.success) throw new InvalidEventError(`形式が違う（${parsed.error.issues[0]?.path.join(".") || "root"}）`);
  const entry = (parsed.data.changed_attributes ?? []).find((change) => "label_list" in change);
  const change = LabelListChange.safeParse(entry?.label_list);
  if (!change.success) return ignore("no-label-change");
  const added = (change.data.current_value ?? []).includes(LABELS.askResolved) && !(change.data.previous_value ?? []).includes(LABELS.askResolved);
  if (!added) return ignore("no-ask-resolved-added");
  return { kind: "ask-resolved", accountId: parsed.data.account.id, conversationId: parsed.data.id };
}

/** Webhook の本文を、ボットが扱うイベントに変える（仕様 7.1 と、2026-10-12 の一覧の仕様 3 節）。扱わないものは ignore、壊れた本文は InvalidEventError */
export function parseEvent(body: unknown): BotEvent {
  const name = typeof body === "object" && body !== null ? (body as { event?: unknown }).event : undefined;
  if (typeof name !== "string") throw new InvalidEventError("event が無い");
  if (name === "webwidget_triggered") return parseWelcome(body);
  if (name === "conversation_updated") return parseConversationUpdated(body);
  if (name !== "message_created" && name !== "message_updated") return ignore(`event:${name}`);

  const parsed = MessagePayload.safeParse(body);
  if (!parsed.success) throw new InvalidEventError(`形式が違う（${parsed.error.issues[0]?.path.join(".") || "root"}）`);
  const message = parsed.data;
  const target = { accountId: message.account.id, conversationId: message.conversation.id, messageId: message.id };
  if (message.private) return ignore("private");

  if (message.event === "message_created") {
    if (message.message_type !== "incoming") return ignore(`message_type:${message.message_type}`);
    // 本文の無い発言（添付だけ）も空の質問として渡す。判定で担当者に引き継がれ、pending のまま放置されない
    const text = (message.content ?? "").trim();
    return { kind: "question", ...target, text: Array.from(text).slice(0, MAX_QUESTION_CHARS).join("") };
  }

  // message_updated: ボット自身の input_select に、訪問者の選択（submitted_values）が入ったときだけ
  if (message.message_type !== "outgoing" || message.content_type !== "input_select" || message.sender?.type !== "agent_bot") {
    return ignore("not-bot-select");
  }
  const value = message.content_attributes?.submitted_values?.[0]?.value;
  if (!value) return ignore("no-selection");
  return { kind: "selection", ...target, value };
}
