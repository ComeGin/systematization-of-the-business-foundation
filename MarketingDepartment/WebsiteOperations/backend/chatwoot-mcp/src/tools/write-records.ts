import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AccessLevel } from "../config.js";
import { CREATABLE, DELETABLE, getResource, RESOURCES, unwrapRecord, UPDATABLE, type ResourceName } from "../resources.js";
import { IdSchema, ResponseFormatSchema } from "../schemas/common.js";
import { errorResult, errorText, formattedResult, jsonResult, sanitize } from "../services/results.js";
import type { ApiRecord, ToolContext } from "../types.js";
import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "./annotations.js";
import { renderRecord } from "./records.js";

const DataSchema = z
  .record(z.string(), z.unknown())
  .refine((data) => Object.keys(data).length > 0, "data must contain at least one field")
  .describe("Fields to set, using Chatwoot API field names (same names returned by chatwoot_get_record)");

const RecordIdSchema = z.union([z.number().int().positive(), z.string().trim().min(1).max(100)]).describe("Record ID (portals: slug)");

function describeResources(names: readonly ResourceName[], withExamples: boolean): string {
  return names
    .map((name) => {
      const resource = RESOURCES[name] as (typeof RESOURCES)[ResourceName] & { example?: string; notes?: string };
      const parts = [`  - ${name}`];
      if (withExamples && resource.example) parts.push(`: ${resource.example}`);
      if (resource.notes) parts.push(`\n      ${resource.notes}`);
      return parts.join("");
    })
    .join("\n");
}

function body(resourceName: ResourceName, data: ApiRecord): ApiRecord {
  const { wrap } = getResource(resourceName);
  return wrap ? { [wrap]: data } : data;
}

function recordResult(action: string, resource: ResourceName, data: unknown, format: "markdown" | "json") {
  const record = sanitize(unwrapRecord(data)) as ApiRecord;
  return formattedResult({ action, resource, record }, format, () => renderRecord(`${action} ${resource} ${String(record.id ?? record.slug ?? "")}`, record), "");
}

const OutputSchema = z.object({ action: z.string(), resource: z.string(), record: z.record(z.string(), z.unknown()) });

export function registerRecordWriteTools(server: McpServer, ctx: ToolContext, accessLevel: AccessLevel): void {
  if (accessLevel === "read_only") return;
  const { client } = ctx;

  server.registerTool(
    "chatwoot_create_record",
    {
      title: "Create Chatwoot Account Record",
      description: `Create an account configuration record. Returns the created record.

Resources and example data:
${describeResources(CREATABLE, true)}

For portal_categories / portal_articles pass the portal slug as parent_id.
Contacts, conversations and messages have their own tools (chatwoot_create_contact, chatwoot_create_conversation, chatwoot_send_message).`,
      inputSchema: z.strictObject({
        resource: z.enum(CREATABLE).describe("Resource type"),
        data: DataSchema,
        parent_id: z.string().trim().min(1).max(100).optional().describe("portal_categories / portal_articles only: portal slug"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: OutputSchema,
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ resource, data, parent_id, response_format }) => {
      const definition = getResource(resource);
      if (definition.parent && !parent_id) return errorText(`Error: ${resource} requires parent_id (${definition.parent.label}). Find it with chatwoot_list_records resource="portals".`);
      try {
        const path = definition.parent ? definition.parent.path(parent_id!) : definition.path;
        const created = await client.request<unknown>("POST", path, body(resource, data));
        return recordResult("created", resource, created, response_format);
      } catch (error) {
        return errorResult(error, "Check parent_id and any IDs inside data.");
      }
    },
  );

  server.registerTool(
    "chatwoot_update_record",
    {
      title: "Update Chatwoot Account Record",
      description: `Update fields of an existing account configuration record (partial update). Returns the updated record.

Resources:
${describeResources(UPDATABLE, false)}

Examples:
  - Recolor a label -> resource="labels", id=3, data={"color":"#FF0000"}
  - Make an agent admin -> resource="agents", id=5, data={"role":"administrator"}
  - Disable a webhook's events -> resource="webhooks", id=1, data={"subscriptions":["conversation_created"]}
  - Deactivate an automation -> resource="automation_rules", id=2, data={"active":false}`,
      inputSchema: z.strictObject({
        resource: z.enum(UPDATABLE).describe("Resource type"),
        id: RecordIdSchema,
        data: DataSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: OutputSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ resource, id, data, response_format }) => {
      try {
        const updated = await client.request<unknown>("PATCH", `${getResource(resource).path}/${encodeURIComponent(String(id))}`, body(resource, data));
        return recordResult("updated", resource, updated, response_format);
      } catch (error) {
        return errorResult(error, `Find valid IDs with chatwoot_list_records resource="${resource}".`);
      }
    },
  );

  server.registerTool(
    "chatwoot_update_account",
    {
      title: "Update Chatwoot Account Settings",
      description: `Update account-wide settings (partial update): name, locale (e.g. "ja"), domain, support_email, timezone,
auto_resolve_after (minutes; null disables), auto_resolve_message, auto_resolve_ignore_waiting, industry, company_size.
Requires an administrator token. Check current values with chatwoot_get_account first.`,
      inputSchema: z.strictObject({ data: DataSchema }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ data }) => {
      try {
        return jsonResult({ updated: "account", account: await client.request<unknown>("PATCH", "", data) }, "");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_set_members",
    {
      title: "Set Chatwoot Inbox / Team Members",
      description: `Change which agents belong to an inbox (who can see and answer its conversations) or a team.

mode: add (keep existing members), remove, replace (members become exactly user_ids).
Returns the resulting member list. Agent IDs: chatwoot_list_records resource="agents".

Examples:
  - Give agent 5 access to inbox 2 -> target="inbox", id=2, user_ids=[5], mode="add"
  - Team 1 is exactly agents 3 and 4 -> target="team", id=1, user_ids=[3,4], mode="replace"`,
      inputSchema: z.strictObject({
        target: z.enum(["inbox", "team"]),
        id: IdSchema("Inbox or team"),
        user_ids: z.array(IdSchema("Agent (user)")).min(1).max(200),
        mode: z.enum(["add", "remove", "replace"]),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ target, id, user_ids, mode }) => {
      const method = mode === "add" ? "POST" : mode === "remove" ? "DELETE" : "PATCH";
      const [path, payload, listPath] =
        target === "inbox"
          ? ["/inbox_members", { inbox_id: id, user_ids }, `/inbox_members/${id}`]
          : [`/teams/${id}/team_members`, { user_ids }, `/teams/${id}/team_members`];
      try {
        await client.request(method, path, payload);
        const members = await client.get<unknown>(listPath);
        const list = (Array.isArray(members) ? members : ((members as { payload?: unknown }).payload ?? [])) as ApiRecord[];
        return jsonResult(
          { target, id, mode, members: list.map((member) => ({ id: member.id, name: member.available_name ?? member.name, email: member.email, role: member.role })) },
          "",
        );
      } catch (error) {
        return errorResult(error, `Check the ${target} ID and agent IDs with chatwoot_list_records.`);
      }
    },
  );

  server.registerTool(
    "chatwoot_set_inbox_agent_bot",
    {
      title: "Set Chatwoot Inbox Agent Bot",
      description: `Connect an agent bot to an inbox so new conversations are handled by the bot first, or disconnect it (agent_bot_id=null).
Bot IDs: chatwoot_list_records resource="agent_bots". Current bot: chatwoot_get_related resource="inbox", relation="agent_bot".`,
      inputSchema: z.strictObject({
        inbox_id: IdSchema("Inbox"),
        agent_bot_id: IdSchema("Agent bot").nullable().describe("Bot to connect, or null to disconnect"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ inbox_id, agent_bot_id }) => {
      try {
        await client.request("POST", `/inboxes/${inbox_id}/set_agent_bot`, { agent_bot: agent_bot_id });
        const current = await client.get<{ agent_bot?: ApiRecord }>(`/inboxes/${inbox_id}/agent_bot`);
        const bot = current.agent_bot && Object.keys(current.agent_bot).length ? current.agent_bot : null;
        return jsonResult({ inbox_id, agent_bot: bot ? { id: bot.id, name: bot.name } : null }, "");
      } catch (error) {
        return errorResult(error, "Check inbox_id and agent_bot_id with chatwoot_list_records.");
      }
    },
  );

  if (accessLevel !== "full") return;

  server.registerTool(
    "chatwoot_delete_record",
    {
      title: "Delete Chatwoot Account Record",
      description: `Permanently delete an account configuration record. This cannot be undone.

Resources: ${DELETABLE.join(", ")}
Side effects: deleting a label removes it from every conversation and contact; deleting an agent removes their access;
deleting a team unassigns its conversations. Confirm the target with chatwoot_get_record first, and prefer deactivating
(e.g. automation_rules active=false) when that is enough.`,
      inputSchema: z.strictObject({
        resource: z.enum(DELETABLE).describe("Resource type"),
        id: IdSchema("Record"),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ resource, id }) => {
      try {
        await client.request("DELETE", `${getResource(resource).path}/${id}`);
        return jsonResult({ deleted: resource, id }, "");
      } catch (error) {
        return errorResult(error, `Find valid IDs with chatwoot_list_records resource="${resource}".`);
      }
    },
  );
}
