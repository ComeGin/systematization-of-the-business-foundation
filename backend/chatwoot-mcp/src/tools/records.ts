import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { extractList, GETTABLE, getResource, LISTABLE, RESOURCES, type ResourceDefinition, type ResourceName } from "../resources.js";
import { PagedOutputSchema, PageSchema, ResponseFormatSchema } from "../schemas/common.js";
import { ChatwootApiError } from "../services/chatwoot-client.js";
import { compact, errorResult, fitToLimit, formattedResult, inline, pagedOutput, renderFields, sanitize, type PagedOutput } from "../services/results.js";
import type { ApiRecord, ToolContext } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

/** 設定系の一覧 API はページングがないため、ツール側で区切る */
const RECORDS_PER_PAGE = 50;

function resourceList(names: readonly ResourceName[]): string {
  return names.map((name) => `  - ${name}: ${RESOURCES[name].description}`).join("\n");
}

function summarize(resource: ResourceDefinition, record: ApiRecord): ApiRecord {
  const summary: ApiRecord = { id: record.id, name: record[resource.nameKey] ?? record.name ?? record.title };
  for (const key of resource.summary) summary[key] = record[key];
  // 一覧では 1 項目あたりの文字数を抑える
  return compact(sanitize(summary, { maxText: 300 }) as ApiRecord);
}

function renderList(resourceName: string, output: PagedOutput<ApiRecord>): string {
  if (output.count === 0) return `# ${resourceName}\n\nNo records found.`;
  const start = (output.page - 1) * RECORDS_PER_PAGE;
  const lines = [`# ${resourceName}`, "", `Showing ${start + 1}-${start + output.count} of ${output.total}`, ""];
  for (const { id, name, ...rest } of output.items) {
    lines.push(`## ${inline(name ?? "(no name)")} (ID: ${inline(id)})`, ...renderFields(rest), "");
  }
  if (output.has_more) lines.push(`More results available: call again with page=${output.next_page}.`);
  if (output.truncation_message) lines.push(`Note: ${output.truncation_message}`);
  return lines.join("\n");
}

export function renderRecord(title: string, record: ApiRecord): string {
  return [`# ${title}`, "", ...renderFields(record)].join("\n");
}

export async function fetchRecord(ctx: ToolContext, resourceName: ResourceName, id: number | string): Promise<ApiRecord> {
  const resource = getResource(resourceName);
  if (resource.get === "from_list") {
    const items = extractList(resource.list!, await ctx.client.get<unknown>(resource.path));
    const found = items.find((item) => String(item.id) === String(id) || (resource.idLabel && item.slug === id));
    if (!found) throw new ChatwootApiError(404, `${resourceName} ${id} does not exist`);
    return found;
  }
  const data = await ctx.client.get<ApiRecord>(`${resource.path}/${encodeURIComponent(String(id))}`);
  return resource.get === "payload" ? (data.payload as ApiRecord) : data;
}

export function registerRecordTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;

  server.registerTool(
    "chatwoot_list_records",
    {
      title: "List Chatwoot Account Records",
      description: `List account configuration records of one type. Read-only.

Resources:
${resourceList(LISTABLE)}

Each item is a summary (id, name, and key fields). Use chatwoot_get_record for every field of one record.
Secrets (webhook secret, bot access tokens, HMAC tokens) are redacted.

Examples:
  - "Which inboxes do we have?" -> resource="inboxes"
  - "Label names" -> resource="labels"
  - "Who can be assigned?" -> resource="agents"
  - "Custom attributes on contacts" -> resource="custom_attribute_definitions", attribute_model="contact_attribute"`,
      inputSchema: z.strictObject({
        resource: z.enum(LISTABLE).describe("Which kind of record to list (see tool description)"),
        attribute_model: z
          .enum(["conversation_attribute", "contact_attribute"])
          .optional()
          .describe("custom_attribute_definitions only (default: conversation_attribute)"),
        filter_type: z.enum(["conversation", "contact", "report"]).optional().describe("custom_filters only (default: conversation)"),
        search: z.string().trim().min(1).max(100).optional().describe("canned_responses only: match short_code or content"),
        page: PageSchema.describe(`Page number (${RECORDS_PER_PAGE} records per page, default 1)`),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: PagedOutputSchema(z.record(z.string(), z.unknown())).extend({ resource: z.string() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ resource: resourceName, attribute_model, filter_type, search, page, response_format }) => {
      try {
        const resource = getResource(resourceName);
        const data = await client.get<unknown>(resource.path, { query: { attribute_model, filter_type, search } });
        const all = extractList(resource.list!, data);
        const start = (page - 1) * RECORDS_PER_PAGE;
        const items = all.slice(start, start + RECORDS_PER_PAGE).map((record) => summarize(resource, record));
        const paged = { ...pagedOutput(page, items, all.length > start + RECORDS_PER_PAGE, all.length), resource: resourceName };
        const [output, text] = fitToLimit(
          paged,
          (o) => (response_format === "json" ? JSON.stringify(o, null, 2) : renderList(resourceName, o)),
          "Use chatwoot_get_record for individual records.",
        );
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_get_record",
    {
      title: "Get Chatwoot Account Record",
      description: `Get every field of one account configuration record by resource type and ID. Read-only.

Resources: ${GETTABLE.join(", ")}
(portals: pass the portal slug as id.) Secrets are redacted.
Returns a "Not found" error if the ID does not exist; find IDs with chatwoot_list_records.`,
      inputSchema: z.strictObject({
        resource: z.enum(GETTABLE).describe("Which kind of record"),
        id: z.union([z.number().int().positive(), z.string().trim().min(1).max(100)]).describe("Record ID (portals: slug)"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ resource: z.string(), record: z.record(z.string(), z.unknown()) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ resource, id, response_format }) => {
      try {
        const record = sanitize(await fetchRecord(ctx, resource, id)) as ApiRecord;
        return formattedResult({ resource, record }, response_format, () => renderRecord(`${resource} ${String(id)}`, record), "Use response_format='json'.");
      } catch (error) {
        return errorResult(error, `Find valid IDs with chatwoot_list_records resource="${resource}".`);
      }
    },
  );
}
