import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Config } from "../config.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { CREATE_EXAMPLES, WRITABLE_RESOURCE_NAMES, WRITABLE_RESOURCES } from "../resources.js";
import { IdSchema, ResponseFormatSchema } from "../schemas/common.js";
import type { MauticClient } from "../services/mautic-client.js";
import { errorResult, sanitize } from "../services/results.js";
import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "./annotations.js";
import { renderRecord } from "./records.js";

type ApiRecord = Record<string, unknown>;

const ResourceSchema = z.enum(WRITABLE_RESOURCE_NAMES).describe(`Resource type: ${WRITABLE_RESOURCE_NAMES.join(", ")}`);

const DataSchema = z
  .record(z.string(), z.unknown())
  .refine((data) => Object.keys(data).length > 0, "data must contain at least one field")
  .describe("Fields to set, using Mautic API field names (same names returned by the get tools)");

const EXAMPLES = Object.entries(CREATE_EXAMPLES)
  .map(([resource, example]) => `  - ${resource}: ${example}`)
  .join("\n");

function recordResult(action: string, resourceName: string, data: ApiRecord, one: string, responseFormat: "markdown" | "json") {
  const record = sanitize(data[one] ?? data) as ApiRecord;
  let text = formatRecordText(action, resourceName, record, responseFormat);
  if (text.length > CHARACTER_LIMIT) text = `${text.slice(0, CHARACTER_LIMIT)}\n… [truncated]`;
  return { content: [{ type: "text" as const, text }], structuredContent: { resource: resourceName, action, record } };
}

function formatRecordText(action: string, resourceName: string, record: ApiRecord, responseFormat: "markdown" | "json"): string {
  return responseFormat === "json"
    ? JSON.stringify({ action, resource: resourceName, record }, null, 2)
    : `${action} ${resourceName} ${String(record.id ?? "")}\n\n${renderRecord(resourceName, record)}`;
}

const OutputSchema = z.object({ resource: z.string(), action: z.string(), record: z.record(z.string(), z.unknown()) });

export function registerWriteTools(server: McpServer, client: MauticClient, accessLevel: Config["MAUTIC_ACCESS_LEVEL"]): void {
  if (accessLevel === "read_only") return;

  server.registerTool(
    "mautic_create_record",
    {
      title: "Create Mautic Record",
      description: `Create a new Mautic record (contact, email, segment, tag, company, note, ...). Returns the created record with its new id.

Required fields differ per resource; if something is missing Mautic returns field-level errors to fix and retry.
Unknown or read-only field names are silently ignored, so check the returned record to confirm every value was saved.
Tip: fetch a similar existing record with mautic_get_record / mautic_get_contact to see field names and formats.

Examples of data:
${EXAMPLES}

Contacts: an existing contact with the same unique identifier (email by default) may be updated instead of duplicated.
This tool does not send emails/SMS or add contacts to segments/campaigns.`,
      inputSchema: z.strictObject({ resource: ResourceSchema, data: DataSchema, response_format: ResponseFormatSchema }),
      outputSchema: OutputSchema,
      annotations: CREATE_ANNOTATIONS,
    },
    async ({ resource, data, response_format }) => {
      try {
        const { path, one } = WRITABLE_RESOURCES[resource];
        const created = await client.write<ApiRecord>("POST", `${path}/new`, data);
        return recordResult("created", resource, created, one, response_format);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_update_record",
    {
      title: "Update Mautic Record",
      description: `Update fields of an existing Mautic record by ID (partial update: only the given fields change). Returns the updated record.

Fails with "Not found" if the ID does not exist (it never creates a record).
Unknown or read-only field names are silently ignored, so check the returned record to confirm the change.

Examples:
  - Rename a segment -> resource="segments", id=3, data={"name":"VIP customers"}
  - Add/remove contact tags -> resource="contacts", id=42, data={"tags":["vip","-trial"]}  ('-' prefix removes a tag)
  - Change contact points -> resource="contacts", id=42, data={"points":150}
  - Unpublish an email -> resource="emails", id=7, data={"isPublished":false}`,
      inputSchema: z.strictObject({ resource: ResourceSchema, id: IdSchema("Record"), data: DataSchema, response_format: ResponseFormatSchema }),
      outputSchema: OutputSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ resource, id, data, response_format }) => {
      try {
        const { path, one } = WRITABLE_RESOURCES[resource];
        // PUT は存在しない ID で新規作成してしまうため、PATCH のみ使う
        const updated = await client.write<ApiRecord>("PATCH", `${path}/${id}/edit`, data);
        return recordResult("updated", resource, updated, one, response_format);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  if (accessLevel !== "full") return;

  server.registerTool(
    "mautic_delete_record",
    {
      title: "Delete Mautic Record",
      description: `Permanently delete a Mautic record by ID. This cannot be undone.

Returns the deleted record as it was just before deletion. Deleting a contact also removes its activity history.
Confirm the target first (e.g. with mautic_get_record / mautic_get_contact) and prefer unpublishing (mautic_update_record with isPublished=false) when that is enough.`,
      inputSchema: z.strictObject({ resource: ResourceSchema, id: IdSchema("Record"), response_format: ResponseFormatSchema }),
      outputSchema: OutputSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async ({ resource, id, response_format }) => {
      try {
        const { path, one } = WRITABLE_RESOURCES[resource];
        const deleted = await client.write<ApiRecord>("DELETE", `${path}/${id}/delete`);
        return recordResult("deleted", resource, deleted, one, response_format);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
