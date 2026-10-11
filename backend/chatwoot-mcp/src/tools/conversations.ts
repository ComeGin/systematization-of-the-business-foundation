import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { PAGE_SIZE } from "../constants.js";
import {
  CONVERSATION_STATUSES,
  ConversationIdSchema,
  FilterConditionSchema,
  IdSchema,
  IncludeLongTextSchema,
  LabelsSchema,
  PagedOutputSchema,
  PageSchema,
  ResponseFormatSchema,
  toFilterPayload,
} from "../schemas/common.js";
import { renderConversationItem, renderMessage, toConversationDetail, toConversationSummary, toMessage } from "../services/format.js";
import { errorResult, fitToLimit, formattedResult, pagedOutput, renderFields, type PagedOutput, type ResponseFormat } from "../services/results.js";
import type { ApiRecord, ChatwootConversation, ChatwootMessage, ConversationCounts, ToolContext } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

const SORT_OPTIONS = [
  "last_activity_at_desc",
  "last_activity_at_asc",
  "created_at_desc",
  "created_at_asc",
  "priority_desc",
  "priority_asc",
  "waiting_since_asc",
  "waiting_since_desc",
] as const;

const ASSIGNEE_COUNT_KEY = { all: "all_count", me: "mine_count", assigned: "assigned_count", unassigned: "unassigned_count" } as const;

/** 最新 20 件（before 指定時も 20 件）。after 指定時は最大 100 件 */
const MESSAGES_PER_PAGE = 20;

export const CONVERSATION_NOT_FOUND = "Conversation IDs are the numbers shown in the Chatwoot UI (#123); find them with chatwoot_list_conversations.";

type ConversationListOutput = PagedOutput<ApiRecord> & { counts: Partial<ConversationCounts> };

function renderConversationList(heading: string, output: ConversationListOutput): string {
  const counts = Object.entries(output.counts).map(([key, value]) => `${key.replace("_count", "")}: ${value}`).join(", ");
  if (output.count === 0) return `# ${heading}\n\nNo conversations found (${counts}).`;

  const start = (output.page - 1) * PAGE_SIZE.conversations;
  const lines = [`# ${heading}`, "", `Showing ${start + 1}-${start + output.count}${output.total === undefined ? "" : ` of ${output.total}`} (${counts})`, ""];
  for (const item of output.items) lines.push(...renderConversationItem(item), "");
  if (output.has_more) lines.push(`More results available: call again with page=${output.next_page}.`);
  if (output.truncation_message) lines.push(`Note: ${output.truncation_message}`);
  return lines.join("\n");
}

function conversationListResult(
  heading: string,
  payload: ChatwootConversation[],
  counts: Partial<ConversationCounts>,
  total: number,
  page: number,
  format: ResponseFormat,
  ctx: ToolContext,
) {
  const items = payload.map((conversation) => toConversationSummary(conversation, ctx.tz));
  const paged = { ...pagedOutput(page, items, page * PAGE_SIZE.conversations < total, total), counts };
  const [output, text] = fitToLimit(paged, (o) => (format === "json" ? JSON.stringify(o, null, 2) : renderConversationList(heading, o)), "Narrow the filters to see the rest.");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

const ConversationListOutputSchema = PagedOutputSchema(z.record(z.string(), z.unknown())).extend({
  counts: z.record(z.string(), z.number()),
});

export function registerConversationTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;

  server.registerTool(
    "chatwoot_list_conversations",
    {
      title: "List Chatwoot Conversations",
      description: `List conversations (customer inquiries) with the filters available in the Chatwoot inbox view. Read-only.

Each item: id (the #number in the UI), status, priority, inbox, channel, contact, assignee, team, labels, unread_count,
created_at / last_activity_at / waiting_since (set while the customer is waiting for a reply), and an excerpt of the last message.
counts gives totals per assignee type for the same filters (mine / assigned / unassigned / all).

Page size is fixed at ${PAGE_SIZE.conversations}. When has_more is true, call again with page=next_page.
For conditions such as date ranges, priority, or custom attributes use chatwoot_filter_conversations.

Examples:
  - "Unanswered open inquiries" -> status="open", assignee_type="unassigned"
  - "Resolved conversations labeled 'billing'" -> status="resolved", labels=["billing"]
  - "Conversations mentioning 'invoice'" -> q="invoice" (searches message text across all statuses)
  - "Longest-waiting customers" -> sort_by="waiting_since_asc"`,
      inputSchema: z.strictObject({
        status: z
          .enum([...CONVERSATION_STATUSES, "all"])
          .default("open")
          .describe("Conversation status (default 'open'). Ignored when q is given"),
        assignee_type: z
          .enum(["all", "me", "assigned", "unassigned"])
          .default("all")
          .describe("'me' = assigned to the token's user (default 'all')"),
        inbox_id: IdSchema("Inbox").optional().describe("Only this inbox (IDs from chatwoot_list_records resource='inboxes')"),
        team_id: IdSchema("Team").optional().describe("Only this team"),
        labels: LabelsSchema.optional().describe("Conversations having ANY of these labels"),
        q: z.string().trim().min(1).max(200).optional().describe("Search text in incoming/outgoing message content (case-insensitive)"),
        sort_by: z.enum(SORT_OPTIONS).default("last_activity_at_desc").describe("Sort order (default 'last_activity_at_desc')"),
        page: PageSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: ConversationListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ status, assignee_type, inbox_id, team_id, labels, q, sort_by, page, response_format }) => {
      try {
        const data = await client.get<{ data: { meta: ConversationCounts; payload: ChatwootConversation[] } }>("/conversations", {
          query: { status, assignee_type, inbox_id, team_id, labels, q, sort_by, page },
        });
        const counts = data.data.meta;
        const heading = q ? `Conversations matching '${q}'` : `Conversations (status: ${status}, assignee: ${assignee_type})`;
        return conversationListResult(heading, data.data.payload, counts, counts[ASSIGNEE_COUNT_KEY[assignee_type]], page, response_format, ctx);
      } catch (error) {
        return errorResult(error, "Check that inbox_id / team_id exist (chatwoot_list_records).");
      }
    },
  );

  server.registerTool(
    "chatwoot_filter_conversations",
    {
      title: "Filter Chatwoot Conversations",
      description: `Find conversations matching advanced conditions (the "Filter" panel in Chatwoot). Read-only.

Standard attribute_key values and their operators:
  - status (open|resolved|pending|snoozed), priority (urgent|high|medium|low): equal_to, not_equal_to
  - assignee_id, inbox_id, team_id: equal_to, not_equal_to, is_present, is_not_present
  - contact_id: equal_to, not_equal_to
  - display_id (the #number): equal_to, not_equal_to, contains, does_not_contain
  - campaign_id: equal_to, not_equal_to, is_present, is_not_present
  - labels: equal_to, not_equal_to, is_present, is_not_present
  - created_at, last_activity_at: is_greater_than, is_less_than (values ["YYYY-MM-DD"]), days_before (values [N])
  - browser_language, conversation_language: equal_to, not_equal_to
  - referer, mail_subject: equal_to, not_equal_to, contains, does_not_contain
Custom conversation attributes: use the attribute key with custom_attribute_type="conversation_attribute"
(definitions: chatwoot_list_records resource="custom_attribute_definitions").

Conditions are evaluated in order; query_operator joins each condition with the next one.
Page size is fixed at ${PAGE_SIZE.conversations}. Returns the same item shape as chatwoot_list_conversations.

Examples:
  - "Urgent open conversations" -> [{attribute_key:"status",filter_operator:"equal_to",values:["open"]},{attribute_key:"priority",filter_operator:"equal_to",values:["urgent"]}]
  - "Created in September 2026" -> [{attribute_key:"created_at",filter_operator:"is_greater_than",values:["2026-08-31"]},{attribute_key:"created_at",filter_operator:"is_less_than",values:["2026-10-01"]}]
  - "Unassigned in inbox 2 with no labels" -> assignee_id is_not_present AND inbox_id equal_to [2] AND labels is_not_present`,
      inputSchema: z.strictObject({
        conditions: z.array(FilterConditionSchema).min(1).max(20).describe("Filter conditions, evaluated in order"),
        page: PageSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: ConversationListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ conditions, page, response_format }) => {
      try {
        const data = await client.request<{ meta: Partial<ConversationCounts>; payload: ChatwootConversation[] }>(
          "POST",
          "/conversations/filter",
          { payload: toFilterPayload(conditions) },
          { query: { page } },
        );
        return conversationListResult("Filtered conversations", data.payload, data.meta, data.meta.all_count ?? 0, page, response_format, ctx);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_get_conversation",
    {
      title: "Get Chatwoot Conversation",
      description: `Get one conversation's details: status, priority, assignee, team, labels, custom/additional attributes (browser, referer, mail subject),
timestamps, and the contact. Read-only. Does not include the message history; use chatwoot_list_messages for that.

conversation_id is the #number shown in the Chatwoot UI.`,
      inputSchema: z.strictObject({
        conversation_id: ConversationIdSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ conversation: z.record(z.string(), z.unknown()) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ conversation_id, response_format }) => {
      try {
        const conversation = toConversationDetail(await client.get<ChatwootConversation>(`/conversations/${conversation_id}`), ctx.tz);
        return formattedResult({ conversation }, response_format, () => renderConversationDetail(conversation), "Use response_format='json'.");
      } catch (error) {
        return errorResult(error, CONVERSATION_NOT_FOUND);
      }
    },
  );

  server.registerTool(
    "chatwoot_list_messages",
    {
      title: "List Chatwoot Messages",
      description: `Read the message history of a conversation in chronological order. Read-only.

Message types: incoming (from the customer), outgoing (reply by an agent/bot), activity (system events such as
"assigned to X" or "resolved"), template. private=true marks an internal note that the customer cannot see.

Paging (message IDs, not page numbers):
  - No cursor: the latest ${MESSAGES_PER_PAGE} messages
  - before=<id>: the ${MESSAGES_PER_PAGE} messages just before that message (read older history; use older_cursor from the previous result)
  - after=<id>: up to 100 messages after that message (check for new replies)

Examples:
  - "What did the customer ask in #42?" -> conversation_id=42
  - "Earlier history" -> conversation_id=42, before=<older_cursor>`,
      inputSchema: z.strictObject({
        conversation_id: ConversationIdSchema,
        before: z.number().int().positive().optional().describe("Return messages older than this message ID"),
        after: z.number().int().min(0).optional().describe("Return messages newer than this message ID"),
        include_activity: z.boolean().default(true).describe("Include system activity messages (default true)"),
        include_long_text: IncludeLongTextSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({
        conversation_id: z.number(),
        count: z.number(),
        older_cursor: z.number().optional(),
        conversation: z.record(z.string(), z.unknown()),
        messages: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ conversation_id, before, after, include_activity, include_long_text, response_format }) => {
      try {
        const data = await client.get<{ meta: ApiRecord; payload: ChatwootMessage[] }>(`/conversations/${conversation_id}/messages`, {
          query: { before, after },
        });
        const all = data.payload;
        const messages = all
          .filter((message) => include_activity || message.message_type !== 2)
          .map((message) => toMessage(message, ctx.tz, include_long_text));
        // 最新 / before 指定で満杯なら、さらに古いメッセージがある可能性がある
        const olderCursor = after === undefined && all.length >= MESSAGES_PER_PAGE ? all[0]?.id : undefined;
        const meta = data.meta;
        const contact = meta.contact as ApiRecord | undefined;
        const assignee = meta.assignee as ApiRecord | undefined;
        const structured = {
          conversation_id,
          count: messages.length,
          ...(olderCursor ? { older_cursor: olderCursor } : {}),
          conversation: {
            labels: meta.labels,
            contact: contact ? { id: contact.id, name: contact.name, email: contact.email, phone_number: contact.phone_number } : null,
            assignee: assignee ? { id: assignee.id, name: assignee.available_name ?? assignee.name } : null,
          },
          messages,
        };
        return formattedResult(
          structured,
          response_format,
          () => {
            const lines = [`# Messages in conversation #${conversation_id}`, ""];
            if (contact) lines.push(`Contact: ${contact.name ?? "-"} (ID: ${contact.id})${assignee ? ` / Assignee: ${assignee.available_name ?? assignee.name}` : ""}`, "");
            if (!messages.length) lines.push("No messages in this range.");
            for (const message of messages) lines.push(...renderMessage(message), "");
            if (olderCursor) lines.push(`Older messages may exist: call again with before=${olderCursor}.`);
            return lines.join("\n");
          },
          "Page with before=<id> to read fewer messages at a time.",
        );
      } catch (error) {
        return errorResult(error, CONVERSATION_NOT_FOUND);
      }
    },
  );
}

export function renderConversationDetail(conversation: ApiRecord): string {
  const { id, contact, ...rest } = conversation;
  const lines = [`# Conversation #${String(id)}`, "", ...renderFields(rest)];
  if (contact) lines.push("", "## Contact", ...renderFields(contact as ApiRecord));
  return lines.join("\n");
}
