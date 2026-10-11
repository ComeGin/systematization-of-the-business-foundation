import * as z from "zod/v4";
import { MAX_QUESTION_CHARS } from "../constants.js";
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
const WelcomePayload = z.object({
  source_id: z.string().min(1),
  inbox: z.object({ id: z.number().int().positive() }).passthrough(),
  account: z.object({ id: z.number().int().positive() }).passthrough(),
  current_conversation: z
    .object({ status: z.enum(["open", "resolved", "pending", "snoozed"]) })
    .passthrough()
    .nullish(),
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
  readonly sourceId: string;
  /** その訪問者のこの受信箱の最後の会話のステータス（会話が無ければ null） */
  readonly currentStatus: ConversationStatus | null;
}

export type BotEvent = QuestionEvent | SelectionEvent | WelcomeEvent | { readonly kind: "ignore"; readonly reason: string };

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
    sourceId: parsed.data.source_id,
    currentStatus: parsed.data.current_conversation?.status ?? null,
  };
}

/** Webhook の本文を、ボットが扱うイベントに変える（仕様 7.1 と、2026-10-12 の一覧の仕様 3 節）。扱わないものは ignore、壊れた本文は InvalidEventError */
export function parseEvent(body: unknown): BotEvent {
  const name = typeof body === "object" && body !== null ? (body as { event?: unknown }).event : undefined;
  if (typeof name !== "string") throw new InvalidEventError("event が無い");
  if (name === "webwidget_triggered") return parseWelcome(body);
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
