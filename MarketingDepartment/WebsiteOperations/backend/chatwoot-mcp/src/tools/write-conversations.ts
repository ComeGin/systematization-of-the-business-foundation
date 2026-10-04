import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AccessLevel } from "../config.js";
import {
  CONVERSATION_PRIORITIES,
  CONVERSATION_STATUSES,
  ConversationIdSchema,
  DateTimeSchema,
  IdSchema,
  LabelsSchema,
  ResponseFormatSchema,
} from "../schemas/common.js";
import { describeError } from "../services/chatwoot-client.js";
import { renderMessage, toConversationDetail, toConversationSummary, toMessage } from "../services/format.js";
import { errorResult, errorText, formattedResult, renderFields } from "../services/results.js";
import type { ApiRecord, ChatwootConversation, ChatwootMessage, ToolContext } from "../types.js";
import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "./annotations.js";
import { CONVERSATION_NOT_FOUND, renderConversationDetail } from "./conversations.js";

export const LabelChangeSchema = z
  .strictObject({
    set: LabelsSchema.optional().describe("Replace all labels with exactly these (empty array clears all)"),
    add: LabelsSchema.optional().describe("Labels to add, keeping the existing ones"),
    remove: LabelsSchema.optional().describe("Labels to remove"),
  })
  .refine((change) => change.set === undefined || (change.add === undefined && change.remove === undefined), "Use either set, or add/remove")
  .describe("Label changes. Label titles must already exist (chatwoot_list_records resource='labels')");

export type LabelChange = z.infer<typeof LabelChangeSchema>;

/** Chatwoot のラベル API は常に「全置き換え」なので、追加・削除は現在値から計算する */
export async function applyLabelChange(ctx: ToolContext, basePath: string, change: LabelChange): Promise<string[]> {
  let labels: string[];
  if (change.set !== undefined) {
    labels = change.set;
  } else {
    const current = await ctx.client.get<{ payload: string[] }>(`${basePath}/labels`);
    const removed = new Set(change.remove ?? []);
    labels = [...new Set([...current.payload, ...(change.add ?? [])])].filter((label) => !removed.has(label));
  }
  const result = await ctx.client.request<{ payload: string[] }>("POST", `${basePath}/labels`, { labels });
  return result.payload;
}

/**
 * 複数の API 呼び出しを順に実行する。途中で失敗したら、成功済みの手順と失敗理由を返す
 * （Chatwoot 側にトランザクションはないため、実行済みの変更は残る）
 */
export async function runSteps(steps: [string, () => Promise<unknown>][], notFoundHint: string): Promise<{ done: string[]; error?: string }> {
  const done: string[] = [];
  for (const [name, step] of steps) {
    try {
      await step();
      done.push(name);
    } catch (error) {
      return { done, error: `Step '${name}' failed: ${describeError(error, notFoundHint)}` };
    }
  }
  return { done };
}

export function partialFailure(done: string[], error: string) {
  return errorText(`${error}\nAlready applied (not rolled back): ${done.length ? done.join(", ") : "nothing"}.`);
}

/**
 * 担当者・チームは Chatwoot 側の規則（チームに属さない担当者は外される、担当者は受信箱のメンバーである必要がある）で
 * 黙って無視されることがあるため、更新後の状態と突き合わせて知らせる
 */
function assignmentWarnings(params: { assignee_id?: number | null; team_id?: number | null }, conversation: ChatwootConversation): string[] {
  const warnings: string[] = [];
  const assignee = conversation.meta.assignee?.id ?? null;
  const team = conversation.meta.team?.id ?? null;
  if (params.assignee_id !== undefined && params.assignee_id !== assignee) {
    warnings.push(
      `assignee is now ${assignee ?? "unassigned"}, not ${params.assignee_id ?? "unassigned"}. Chatwoot requires the agent to be a member of the conversation's inbox, ` +
        "and of its team when one is set (chatwoot_set_members adds them).",
    );
  }
  if (params.team_id !== undefined && (params.team_id ?? null) !== team) {
    warnings.push(`team is now ${team ?? "none"}, not ${params.team_id ?? "none"}.`);
  }
  return warnings;
}

export function registerConversationWriteTools(server: McpServer, ctx: ToolContext, accessLevel: AccessLevel): void {
  if (accessLevel === "read_only") return;
  const { client, tz } = ctx;

  server.registerTool(
    "chatwoot_send_message",
    {
      title: "Send Chatwoot Message",
      description: `Post a message in a conversation as the token's user.

IMPORTANT: a normal outgoing message (private=false) is delivered to the customer immediately (website widget, email, LINE, ...)
and cannot be recalled. Use private=true for an internal note that only agents see.
Confirm the conversation and the exact text with the user before sending a customer-facing reply.

Examples:
  - Reply to the customer in #42 -> conversation_id=42, content="お問い合わせありがとうございます。..."
  - Leave a note for colleagues -> conversation_id=42, content="Refund approved by finance", private=true`,
      inputSchema: z.strictObject({
        conversation_id: ConversationIdSchema,
        content: z.string().trim().min(1).max(20_000).describe("Message text (Markdown is supported in the widget)"),
        private: z.boolean().default(false).describe("true = internal note (not sent to the customer). Default false"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ conversation_id: z.number(), message: z.record(z.string(), z.unknown()) }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ conversation_id, content, private: isPrivate, response_format }) => {
      try {
        const created = await client.request<ChatwootMessage>("POST", `/conversations/${conversation_id}/messages`, {
          content,
          message_type: "outgoing",
          private: isPrivate,
        });
        const message = toMessage(created, tz, true);
        return formattedResult(
          { conversation_id, message },
          response_format,
          () => [`${isPrivate ? "Private note added" : "Message sent"} in conversation #${conversation_id}`, "", ...renderMessage(message)].join("\n"),
          "",
        );
      } catch (error) {
        return errorResult(error, CONVERSATION_NOT_FOUND);
      }
    },
  );

  // 本番のエージェントは chatwoot_send_message ではこちらを使う。private を入力に持たないので、顧客に送る経路が存在しない
  server.registerTool(
    "chatwoot_add_private_note",
    {
      title: "Add Chatwoot Private Note",
      description: `Add an internal note to a conversation. The note is visible to agents only and is NEVER sent to the customer.

This tool has no 'private' option: every call creates a private note. To reply to the customer use chatwoot_send_message
(not available to agents that must not contact customers).

Examples:
  - Record a triage result in #42 -> conversation_id=42, content="Triage: billing question, suggest team Billing, priority medium"
  - Leave a draft reply for a human to review -> conversation_id=42, content="Draft reply: ..."`,
      inputSchema: z.strictObject({
        conversation_id: ConversationIdSchema,
        content: z.string().trim().min(1).max(20_000).describe("Note text (Markdown is supported)"),
      }),
      outputSchema: z.object({ conversation_id: z.number(), message: z.record(z.string(), z.unknown()) }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ conversation_id, content }) => {
      try {
        const created = await client.request<ChatwootMessage>("POST", `/conversations/${conversation_id}/messages`, {
          content,
          message_type: "outgoing",
          private: true,
        });
        const message = toMessage(created, tz, true);
        // 想定外に private でなく記録された場合は、成功として返さずに知らせる（顧客に届いた可能性がある）
        if (created.private !== true) {
          return errorText(
            `Error: Chatwoot recorded message ${String(created.id)} in conversation #${conversation_id} as a non-private message. ` +
              "It may have been delivered to the customer; check the conversation in the Chatwoot UI.",
          );
        }
        return formattedResult(
          { conversation_id, message },
          "markdown",
          () => [`Private note added in conversation #${conversation_id}`, "", ...renderMessage(message)].join("\n"),
          "",
        );
      } catch (error) {
        return errorResult(error, CONVERSATION_NOT_FOUND);
      }
    },
  );

  server.registerTool(
    "chatwoot_update_conversation",
    {
      title: "Update Chatwoot Conversation",
      description: `Change a conversation's status, priority, assignee, team, labels and custom attributes in one call.
Only the given fields change. Returns the updated conversation.

- status: open | resolved | pending | snoozed (snoozed_until sets when it reopens; omit to snooze until the next customer reply)
- priority: urgent | high | medium | low | none
- assignee_id: agent user ID (null = unassign). team_id: team ID (null = remove team)
  Chatwoot clears the assignee when the conversation moves to a team the agent is not a member of, so when you set both,
  the agent must belong to that team (chatwoot_get_related resource="team", relation="members"). The result warns if the
  assignee or team did not stick.
- labels: { set } replaces all labels, { add, remove } edits them
- custom_attributes: merged into existing values; remove_custom_attributes deletes keys

Changes are applied one by one; if a step fails, earlier steps stay applied and the error lists them.

Examples:
  - Resolve #42 -> conversation_id=42, status="resolved"
  - Escalate -> conversation_id=42, priority="urgent", team_id=2, labels={add:["escalated"]}
  - Snooze until tomorrow 9:00 -> status="snoozed", snoozed_until="2026-09-17T09:00:00+09:00"`,
      inputSchema: z.strictObject({
        conversation_id: ConversationIdSchema,
        status: z.enum(CONVERSATION_STATUSES).optional(),
        snoozed_until: DateTimeSchema.optional().describe("With status='snoozed': when to reopen"),
        priority: z.enum(CONVERSATION_PRIORITIES).optional(),
        assignee_id: IdSchema("Agent (user)").nullable().optional().describe("Agent to assign (null = unassign). IDs: chatwoot_list_records resource='agents'"),
        team_id: IdSchema("Team").nullable().optional().describe("Team to assign (null = remove the team)"),
        labels: LabelChangeSchema.optional(),
        custom_attributes: z.record(z.string(), z.unknown()).optional().describe("Custom attribute values to set (merged with existing ones)"),
        remove_custom_attributes: z.array(z.string().min(1)).max(50).optional().describe("Custom attribute keys to delete"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ applied: z.array(z.string()), conversation: z.record(z.string(), z.unknown()) }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (params) => {
      const { conversation_id: id, response_format } = params;
      const base = `/conversations/${id}`;
      const steps: [string, () => Promise<unknown>][] = [];

      if (params.snoozed_until !== undefined && params.status !== "snoozed") {
        return errorText("Error: snoozed_until can only be used with status='snoozed'.");
      }
      if (params.status !== undefined) {
        const snoozedUntil = params.snoozed_until ? tz.toUnix(params.snoozed_until) : undefined;
        steps.push(["status", () => client.request("POST", `${base}/toggle_status`, { status: params.status, snoozed_until: snoozedUntil })]);
      }
      if (params.priority !== undefined) {
        // "none" は優先度なし（Chatwoot は空値で解除する）
        const priority = params.priority === "none" ? null : params.priority;
        steps.push(["priority", () => client.request("POST", `${base}/toggle_priority`, { priority })]);
      }
      // 担当者はチームより後に設定する。Chatwoot はチーム変更時に「そのチームに属さない担当者」を外すため
      if (params.team_id !== undefined) {
        steps.push(["team", () => client.request("POST", `${base}/assignments`, { team_id: params.team_id ?? 0 })]);
      }
      if (params.assignee_id !== undefined) {
        steps.push(["assignee", () => client.request("POST", `${base}/assignments`, { assignee_id: params.assignee_id })]);
      }
      if (params.labels !== undefined) {
        const change = params.labels;
        steps.push(["labels", () => applyLabelChange(ctx, base, change)]);
      }
      if (params.custom_attributes !== undefined) {
        const attributes = params.custom_attributes;
        steps.push(["custom_attributes", () => client.request("POST", `${base}/custom_attributes`, { custom_attributes: attributes, merge: true })]);
      }
      if (params.remove_custom_attributes !== undefined) {
        const keys = params.remove_custom_attributes;
        steps.push(["remove_custom_attributes", () => client.request("POST", `${base}/destroy_custom_attributes`, { custom_attributes: keys })]);
      }
      if (steps.length === 0) return errorText("Error: nothing to update. Pass at least one of status, priority, assignee_id, team_id, labels, custom_attributes.");

      const { done, error } = await runSteps(steps, CONVERSATION_NOT_FOUND);
      if (error) return partialFailure(done, error);
      try {
        const updated = await client.get<ChatwootConversation>(base);
        const conversation = toConversationDetail(updated, tz);
        const warnings = assignmentWarnings(params, updated);
        return formattedResult(
          { applied: done, ...(warnings.length ? { warnings } : {}), conversation },
          response_format,
          () =>
            [`Updated (${done.join(", ")})`, ...warnings.map((warning) => `Warning: ${warning}`), "", renderConversationDetail(conversation)].join("\n"),
          "Use response_format='json'.",
        );
      } catch (fetchError) {
        return errorText(`Updated (${done.join(", ")}), but re-reading the conversation failed: ${describeError(fetchError)}`);
      }
    },
  );

  server.registerTool(
    "chatwoot_create_conversation",
    {
      title: "Create Chatwoot Conversation",
      description: `Start a new conversation with an existing contact in an inbox (for example an outbound email or an API-channel ticket).

inbox_id must be an inbox where the contact can be reached; check with chatwoot_get_related resource="contact", relation="contactable_inboxes"
(pass its source_id when one is listed). If message is given it is sent to the contact immediately.
Returns the new conversation (its id is the #number).

Examples:
  - Email a lead -> inbox_id=3 (email inbox), contact_id=12, message="...", additional_attributes={"mail_subject":"ご提案の件"}
  - Open an internal ticket -> inbox_id=5 (API inbox), contact_id=12, status="pending"`,
      inputSchema: z.strictObject({
        inbox_id: IdSchema("Inbox"),
        contact_id: IdSchema("Contact"),
        source_id: z.string().trim().min(1).max(255).optional().describe("Contact's source_id in the inbox (from contactable_inboxes); generated when omitted"),
        message: z.string().trim().min(1).max(20_000).optional().describe("First message, sent to the contact"),
        status: z.enum(["open", "pending", "resolved"]).optional().describe("Initial status (default open)"),
        assignee_id: IdSchema("Agent (user)").optional(),
        team_id: IdSchema("Team").optional(),
        custom_attributes: z.record(z.string(), z.unknown()).optional(),
        additional_attributes: z.record(z.string(), z.unknown()).optional().describe("e.g. {\"mail_subject\": \"...\"} for email inboxes"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ conversation: z.record(z.string(), z.unknown()) }),
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ message, response_format, ...body }) => {
      try {
        const created = await client.request<ChatwootConversation>("POST", "/conversations", {
          ...body,
          ...(message ? { message: { content: message } } : {}),
        });
        // 作成レスポンスは内部 ID（id）を含む形のため、表示番号で取り直す
        const displayId = (created as unknown as ApiRecord).display_id ?? created.id;
        const conversation = toConversationSummary(await client.get<ChatwootConversation>(`/conversations/${String(displayId)}`), tz);
        return formattedResult(
          { conversation },
          response_format,
          () => [`Created conversation #${String(conversation.id)}`, "", ...renderFields(conversation)].join("\n"),
          "",
        );
      } catch (error) {
        return errorResult(error, "Check inbox_id (chatwoot_list_records resource='inboxes') and contact_id (chatwoot_list_contacts).");
      }
    },
  );
}
