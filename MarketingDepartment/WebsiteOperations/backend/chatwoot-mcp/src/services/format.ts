import type { ApiRecord, ChatwootContact, ChatwootConversation, ChatwootMessage } from "../types.js";
import { compact, inline, renderFields, sanitize } from "./results.js";
import type { TimeZone } from "./time.js";

// Message.message_type の値
const MESSAGE_TYPES: Record<number, string> = { 0: "incoming", 1: "outgoing", 2: "activity", 3: "template" };

/** 一覧の 1 件に載せるメッセージ本文の最大文字数 */
const EXCERPT_LENGTH = 200;

function excerpt(text: string | null | undefined, length = EXCERPT_LENGTH): string | null {
  if (!text) return null;
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > length ? `${single.slice(0, length)}…` : single;
}

function senderLabel(sender: ChatwootMessage["sender"]): string | null {
  if (!sender) return null;
  const name = sender.available_name || sender.name || `#${sender.id}`;
  return sender.type ? `${name} (${sender.type})` : name;
}

export function messageType(value: number): string {
  return MESSAGE_TYPES[value] ?? String(value);
}

// ---- 会話 ----

export function toConversationSummary(conversation: ChatwootConversation, tz: TimeZone): ApiRecord {
  const { meta } = conversation;
  const contact = meta.sender;
  const last = conversation.last_non_activity_message;
  return compact({
    id: conversation.id,
    status: conversation.status,
    priority: conversation.priority,
    inbox_id: conversation.inbox_id,
    channel: meta.channel,
    contact: contact ? compact({ id: contact.id, name: contact.name, email: contact.email, phone_number: contact.phone_number }) : null,
    assignee: meta.assignee ? compact({ id: meta.assignee.id, name: meta.assignee.available_name ?? meta.assignee.name, type: meta.assignee_type }) : null,
    team: meta.team ? { id: meta.team.id, name: meta.team.name } : null,
    labels: conversation.labels,
    unread_count: conversation.unread_count || null,
    muted: conversation.muted || null,
    created_at: tz.format(conversation.created_at),
    last_activity_at: tz.format(conversation.last_activity_at),
    // 顧客の返信待ちが始まった時刻（担当者が未返信の間だけ値がある）
    waiting_since: tz.format(conversation.waiting_since),
    snoozed_until: tz.format(conversation.snoozed_until),
    last_message: last
      ? compact({
          type: messageType(last.message_type),
          private: last.private || null,
          sender: senderLabel(last.sender),
          content: excerpt(last.content),
          created_at: tz.format(last.created_at),
        })
      : null,
    // カスタム属性のキーは運用者が自由に決めるため、additional_attributes と同じく秘匿情報らしいキーの値を伏せる
    custom_attributes: sanitize(conversation.custom_attributes),
  });
}

export function toConversationDetail(conversation: ChatwootConversation, tz: TimeZone): ApiRecord {
  return compact({
    ...toConversationSummary(conversation, tz),
    uuid: conversation.uuid,
    can_reply: conversation.can_reply,
    first_reply_at: tz.format(conversation.first_reply_created_at),
    additional_attributes: sanitize(conversation.additional_attributes),
    contact: conversation.meta.sender ? toContactSummary(conversation.meta.sender, tz) : null,
  });
}

function conversationTitle(item: ApiRecord): string {
  const contact = item.contact as ApiRecord | undefined;
  const who = contact ? inline(contact.name ?? contact.email ?? contact.phone_number ?? `contact ${contact.id}`) : "(unknown contact)";
  return `## #${inline(item.id)} ${who} [${inline(item.status)}]`;
}

export function renderConversationItem(item: ApiRecord): string[] {
  const lines = [conversationTitle(item)];
  const { id: _id, contact: _contact, status: _status, last_message, ...rest } = item;
  for (const [key, value] of Object.entries(rest)) lines.push(`- **${key}**: ${formatInline(value)}`);
  if (last_message) {
    const last = last_message as ApiRecord;
    lines.push(`- **last_message** (${inline(last.type)}${last.private ? ", private" : ""}, ${inline(last.sender)}, ${inline(last.created_at)}): ${inline(last.content)}`);
  }
  return lines;
}

// ---- メッセージ ----

export function toMessage(message: ChatwootMessage, tz: TimeZone, includeLongText: boolean): ApiRecord {
  return compact({
    id: message.id,
    type: messageType(message.message_type),
    private: message.private || null,
    sender: senderLabel(message.sender),
    content: sanitize(message.content, { includeLongText }),
    content_type: message.content_type === "text" ? null : message.content_type,
    // 送信状態（failed のときは content_attributes.external_error に理由が入る）
    status: message.status === "sent" ? null : message.status,
    content_attributes: sanitize(message.content_attributes, { includeLongText }),
    attachments: (message.attachments ?? []).map((attachment) =>
      compact({ id: attachment.id, file_type: attachment.file_type, extension: attachment.extension, file_size: attachment.file_size, url: attachment.data_url }),
    ),
    created_at: tz.format(message.created_at),
  });
}

export function renderMessage(message: ApiRecord): string[] {
  const flags = [message.type, message.private ? "private note" : null, message.status].filter(Boolean).join(", ");
  const lines = [`### [${inline(message.id)}] ${inline(message.created_at)} ${inline(message.sender)} (${flags})`, inline(message.content)];
  for (const attachment of (message.attachments as ApiRecord[] | undefined) ?? []) {
    lines.push(`- attachment: ${inline(attachment.file_type)} ${inline(attachment.url)}`);
  }
  if (message.content_attributes) lines.push(`- content_attributes: ${inline(message.content_attributes)}`);
  return lines;
}

// ---- コンタクト ----

export function toContactSummary(contact: ChatwootContact, tz: TimeZone): ApiRecord {
  const additional = contact.additional_attributes ?? {};
  return compact({
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone_number: contact.phone_number,
    identifier: contact.identifier,
    company: additional.company_name,
    city: additional.city,
    country: additional.country,
    blocked: contact.blocked || null,
    inboxes: (contact.contact_inboxes ?? []).map((ci) => (ci.inbox ? `${ci.inbox.name} (inbox ${ci.inbox.id})` : null)).filter(Boolean),
    created_at: tz.format(contact.created_at),
    last_activity_at: tz.format(contact.last_activity_at),
    custom_attributes: sanitize(contact.custom_attributes),
  });
}

export function toContactDetail(contact: ChatwootContact, tz: TimeZone): ApiRecord {
  return compact({
    ...toContactSummary(contact, tz),
    availability_status: contact.availability_status,
    additional_attributes: sanitize(contact.additional_attributes),
    contact_inboxes: (contact.contact_inboxes ?? []).map((ci) =>
      compact({ inbox_id: ci.inbox?.id, inbox_name: ci.inbox?.name, channel_type: ci.inbox?.channel_type, source_id: ci.source_id }),
    ),
    inboxes: null,
  });
}

export function renderContactItem(item: ApiRecord): string[] {
  const { id, name, ...rest } = item;
  return [`## ${inline(name ?? item.email ?? item.phone_number ?? "(no name)")} (ID: ${inline(id)})`, ...renderFields(rest)];
}

function formatInline(value: unknown): string {
  if (Array.isArray(value) && value.every((item) => typeof item !== "object")) return value.join(", ");
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .map(([key, child]) => `${key}=${typeof child === "object" ? JSON.stringify(child) : String(child)}`)
      .join(", ");
  }
  return inline(value);
}
