import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { CHARACTER_LIMIT } from "../constants.js";
import { getResource, RESOURCE_NAMES, RESOURCES, type ResourceDefinition } from "../resources.js";
import {
  IdSchema,
  IncludeLongTextSchema,
  LimitSchema,
  OffsetSchema,
  PagedOutputSchema,
  ResponseFormatSchema,
} from "../schemas/common.js";
import type { MauticClient } from "../services/mautic-client.js";
import { errorResult, fitToLimit, inline, pagedOutput, sanitize, type PagedOutput } from "../services/results.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

type ApiRecord = Record<string, unknown>;

const RESOURCE_LIST = Object.entries(RESOURCES)
  .map(([name, resource]) => `  - ${name}: ${resource.description}`)
  .join("\n");

// エンティティごとに「名前」にあたる項目が異なる（会社は fields.all.companyname）
const NAME_PATHS = ["name", "title", "subject", "tag", "label", "fields.all.companyname", "username"];

function valueAt(record: ApiRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (current !== null && typeof current === "object" ? (current as ApiRecord)[key] : undefined), record);
}

function summarize(resource: ResourceDefinition, record: ApiRecord): ApiRecord {
  const summary: ApiRecord = { id: record.id };
  const name = NAME_PATHS.map((path) => valueAt(record, path)).find((value) => typeof value === "string" && value !== "");
  if (name) summary.name = name;
  if (typeof record.isPublished === "boolean") summary.is_published = record.isPublished;

  const category = record.category as ApiRecord | null | undefined;
  if (category && typeof category === "object") summary.category = category.title ?? category.name;

  for (const path of resource.summary) {
    const value = valueAt(record, path);
    if (value !== undefined && value !== null && value !== "") summary[path] = value;
  }
  if (record.dateAdded) summary.date_added = record.dateAdded;
  if (record.dateModified) summary.date_modified = record.dateModified;

  // 一覧では 1 項目あたりの文字数を抑える
  return sanitize(summary, { maxText: 300 }) as ApiRecord;
}

function renderList(resourceName: string, output: PagedOutput<ApiRecord>): string {
  if (output.count === 0) return `# ${resourceName}\n\nNo records found (total: ${output.total}).`;

  const lines = [`# ${resourceName}`, "", `Showing ${output.offset + 1}-${output.offset + output.count} of ${output.total}`, ""];
  for (const { id, name, ...rest } of output.items) {
    lines.push(`## ${inline(name ?? "(no name)")} (ID: ${inline(id)})`);
    for (const [key, value] of Object.entries(rest)) lines.push(`- **${key}**: ${inline(value)}`);
    lines.push("");
  }
  if (output.has_more) lines.push(`More results available: call again with offset=${output.next_offset}.`);
  if (output.truncation_message) lines.push(`Note: ${output.truncation_message}`);
  return lines.join("\n");
}

export function renderRecord(resourceName: string, record: ApiRecord): string {
  const lines = [`# ${resourceName} ${inline(record.id)}`, ""];
  const nested: [string, unknown][] = [];
  for (const [key, value] of Object.entries(record)) {
    // Markdown では空の項目を省く（全項目が必要な場合は response_format="json"）
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") nested.push([key, value]);
    else lines.push(`- **${key}**: ${inline(value)}`);
  }
  for (const [key, value] of nested) {
    lines.push("", `## ${key}`, "```json", JSON.stringify(value, null, 2), "```");
  }
  return lines.join("\n");
}

const ListRecordsInputSchema = z.strictObject({
  resource: z.enum(RESOURCE_NAMES).describe("Which kind of Mautic record to list (see tool description)"),
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Mautic search expression: free text, or commands like 'is:published', 'is:unpublished', 'category:<alias>', 'ids:1,2,3'. '%' is the wildcard."),
  published_only: z.boolean().default(false).describe("Return only published records (default false)"),
  limit: LimitSchema(100, 20),
  offset: OffsetSchema,
  order_by: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a single property name such as 'name' or 'dateAdded'")
    .optional()
    .describe("Entity property to sort by in camelCase, e.g. 'id', 'name', 'dateAdded'. Omit for the default order."),
  order_direction: z.enum(["asc", "desc"]).default("asc").describe("Sort direction (default 'asc')"),
  response_format: ResponseFormatSchema,
});

const GetRecordInputSchema = z.strictObject({
  resource: z.enum(RESOURCE_NAMES).describe("Which kind of Mautic record (see tool description)"),
  id: IdSchema("Record"),
  include_long_text: IncludeLongTextSchema,
  response_format: ResponseFormatSchema,
});

export function registerRecordTools(server: McpServer, client: MauticClient): void {
  server.registerTool(
    "mautic_list_records",
    {
      title: "List Mautic Records",
      description: `List records of one Mautic resource type with search and pagination. Read-only.

Resources:
${RESOURCE_LIST}

Each item is a summary (id, name, is_published, category, dates, plus key fields per resource).
Use mautic_get_record for every field of one record. For contacts use mautic_list_contacts instead.

Examples:
  - "Which emails were sent the most?" -> resource="emails", then compare sentCount
  - "Published landing pages" -> resource="pages", published_only=true
  - "Segment alias for 'Newsletter'" -> resource="segments", search="Newsletter"
  - "Newest forms" -> resource="forms", order_by="dateAdded", order_direction="desc"

Pagination: when has_more is true, call again with offset=next_offset.`,
      inputSchema: ListRecordsInputSchema,
      outputSchema: PagedOutputSchema(z.record(z.string(), z.unknown())).extend({ resource: z.string() }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params) => {
      try {
        const resource = getResource(params.resource);
        const list = await client.getList<ApiRecord>(resource.path, resource.multi, {
          search: params.search,
          published: params.published_only ? 1 : undefined,
          start: params.offset,
          limit: params.limit,
          orderBy: params.order_by,
          orderByDir: params.order_by ? params.order_direction.toUpperCase() : undefined,
        });

        const paged = pagedOutput(list.total, params.offset, list.items.map((item) => summarize(resource, item)));
        const [output, text] = fitToLimit({ ...paged, resource: params.resource }, (o) =>
          params.response_format === "json" ? JSON.stringify(o, null, 2) : renderList(params.resource, o),
        );
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_get_record",
    {
      title: "Get Mautic Record",
      description: `Get every field of one Mautic record by resource type and ID. Read-only.

Resources: ${RESOURCE_NAMES.join(", ")} (reports: use mautic_run_report; contacts: use mautic_get_contact).

Long strings such as email/page HTML are shortened unless include_long_text=true. Secrets are redacted.
Returns a "Not found" error if the ID does not exist; find IDs with mautic_list_records.`,
      inputSchema: GetRecordInputSchema,
      outputSchema: z.object({ resource: z.string(), record: z.record(z.string(), z.unknown()) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ resource: resourceName, id, include_long_text, response_format }) => {
      const resource = getResource(resourceName);
      if (resource.gettable === false) {
        return { content: [{ type: "text", text: `Error: ${resourceName} cannot be fetched with this tool. ${resource.getHint}` }], isError: true };
      }
      try {
        const data = await client.get<ApiRecord>(`${resource.path}/${id}`);
        const record = sanitize(data[resource.one] ?? data, { includeLongText: include_long_text }) as ApiRecord;

        let text = response_format === "json" ? JSON.stringify(record, null, 2) : renderRecord(resourceName, record);
        if (text.length > CHARACTER_LIMIT) {
          text = `${text.slice(0, CHARACTER_LIMIT)}\n… [truncated at ${CHARACTER_LIMIT} chars. Use response_format="json" and look at structuredContent, or omit include_long_text.]`;
        }
        return { content: [{ type: "text", text }], structuredContent: { resource: resourceName, record } };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
