import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { IdSchema } from "../schemas/common.js";
import { toConversationSummary } from "../services/format.js";
import { errorResult, errorText, jsonResult } from "../services/results.js";
import type { ApiRecord, ChatwootConversation, ToolContext } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

interface Relation {
  description: string;
  path: (id: number) => string;
  /** レスポンスをモデルに返す形に変換する */
  transform?: (data: unknown, ctx: ToolContext) => unknown;
}

const payloadOf = (data: unknown) => (data as { payload?: unknown } | null)?.payload ?? data;

const RELATIONS: Record<string, Record<string, Relation>> = {
  contact: {
    conversations: {
      description: "all conversations of the contact (summaries, newest activity first)",
      path: (id) => `/contacts/${id}/conversations`,
      transform: (data, ctx) => (payloadOf(data) as ChatwootConversation[]).map((conversation) => toConversationSummary(conversation, ctx.tz)),
    },
    labels: { description: "labels on the contact", path: (id) => `/contacts/${id}/labels`, transform: payloadOf },
    contactable_inboxes: {
      description: "inboxes where a new conversation can be started with this contact (with source_id)",
      path: (id) => `/contacts/${id}/contactable_inboxes`,
      transform: payloadOf,
    },
  },
  conversation: {
    labels: { description: "labels on the conversation", path: (id) => `/conversations/${id}/labels`, transform: payloadOf },
    reporting_events: {
      description: "metric events such as first_response and conversation_resolved (value in seconds)",
      path: (id) => `/conversations/${id}/reporting_events`,
      transform: payloadOf,
    },
  },
  inbox: {
    members: { description: "agents who can access the inbox", path: (id) => `/inbox_members/${id}`, transform: payloadOf },
    agent_bot: { description: "agent bot connected to the inbox (null if none)", path: (id) => `/inboxes/${id}/agent_bot` },
    message_templates: { description: "WhatsApp message templates of the inbox", path: (id) => `/inboxes/${id}/message_templates` },
  },
  team: {
    members: { description: "agents in the team", path: (id) => `/teams/${id}/team_members` },
  },
};

type RelatedResource = keyof typeof RELATIONS;
const RELATION_NAMES = [...new Set(Object.values(RELATIONS).flatMap((relations) => Object.keys(relations)))] as [string, ...string[]];

const RELATION_LIST = Object.entries(RELATIONS)
  .map(([resource, relations]) =>
    Object.entries(relations)
      .map(([name, relation]) => `  - ${resource} / ${name}: ${relation.description}`)
      .join("\n"),
  )
  .join("\n");

export function registerRelatedTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "chatwoot_get_related",
    {
      title: "Get Chatwoot Related Records",
      description: `Get records related to one contact, conversation, inbox or team. Read-only.

resource / relation:
${RELATION_LIST}

For conversations, id is the #number shown in the UI.

Examples:
  - "Past inquiries from contact 12" -> resource="contact", id=12, relation="conversations"
  - "Who handles inbox 3?" -> resource="inbox", id=3, relation="members"
  - "Response time events of #42" -> resource="conversation", id=42, relation="reporting_events"`,
      inputSchema: z.strictObject({
        resource: z.enum(Object.keys(RELATIONS) as [RelatedResource, ...RelatedResource[]]).describe("Parent record type"),
        id: IdSchema("Parent record"),
        relation: z.enum(RELATION_NAMES).describe("Which related data to return (must be valid for the resource)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ resource, id, relation }) => {
      const definition = RELATIONS[resource]?.[relation];
      if (!definition) {
        return errorText(`Error: relation '${relation}' is not available for ${resource}. Valid relations: ${Object.keys(RELATIONS[resource] ?? {}).join(", ")}.`);
      }
      try {
        const data = await ctx.client.get<unknown>(definition.path(id));
        const result = definition.transform ? definition.transform(data, ctx) : data;
        return jsonResult({ resource, id, relation, data: result as ApiRecord }, "Use more specific tools to narrow the result.");
      } catch (error) {
        return errorResult(error, `Verify the ${resource} ID first.`);
      }
    },
  );
}
