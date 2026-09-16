import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { PAGE_SIZE } from "../constants.js";
import { FilterConditionSchema, IdSchema, LabelsSchema, PagedOutputSchema, PageSchema, ResponseFormatSchema, toFilterPayload } from "../schemas/common.js";
import { renderContactItem, toContactDetail, toContactSummary } from "../services/format.js";
import { errorResult, fitToLimit, formattedResult, pagedOutput, renderFields, type PagedOutput, type ResponseFormat } from "../services/results.js";
import type { ApiRecord, ChatwootContact, ToolContext } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

const SORT_FIELDS = ["name", "email", "phone_number", "last_activity_at", "created_at", "company_name", "city", "country"] as const;

export const CONTACT_NOT_FOUND = "Find contact IDs with chatwoot_list_contacts (q searches name, email, phone number and identifier).";

interface ContactListResponse {
  meta: { count: number; current_page: number | string; has_more?: boolean };
  payload: ChatwootContact[];
}

function renderContactList(heading: string, output: PagedOutput<ApiRecord>): string {
  if (output.count === 0) return `# ${heading}\n\nNo contacts found.`;
  const start = (output.page - 1) * PAGE_SIZE.contacts;
  const lines = [`# ${heading}`, "", `Showing ${start + 1}-${start + output.count}${output.total === undefined ? "" : ` of ${output.total}`}`, ""];
  for (const item of output.items) lines.push(...renderContactItem(item), "");
  if (output.has_more) lines.push(`More results available: call again with page=${output.next_page}.`);
  if (output.truncation_message) lines.push(`Note: ${output.truncation_message}`);
  return lines.join("\n");
}

function contactListResult(heading: string, data: ContactListResponse, page: number, format: ResponseFormat, ctx: ToolContext) {
  const items = data.payload.map((contact) => toContactSummary(contact, ctx.tz));
  // 検索 API は総件数の代わりに has_more を返す（meta.count はそのページの件数）
  const paged =
    data.meta.has_more === undefined
      ? pagedOutput(page, items, page * PAGE_SIZE.contacts < data.meta.count, data.meta.count)
      : pagedOutput(page, items, data.meta.has_more);
  const [output, text] = fitToLimit(paged, (o) => (format === "json" ? JSON.stringify(o, null, 2) : renderContactList(heading, o)), "Narrow the search to see the rest.");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

export function registerContactTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;

  server.registerTool(
    "chatwoot_list_contacts",
    {
      title: "List Chatwoot Contacts",
      description: `List or search contacts (customers who contacted you). Read-only.

With q: partial match on name, email, phone number or identifier (all contacts).
Without q: contacts that have an email, phone number or identifier (anonymous website visitors are excluded).

Each item: id, name, email, phone_number, identifier, company, city, country, inboxes, created_at, last_activity_at, custom_attributes.
Page size is fixed at ${PAGE_SIZE.contacts}. When has_more is true, call again with page=next_page.
For conditions (created date, country, custom attributes...) use chatwoot_filter_contacts.

Examples:
  - "Find the customer taro@example.com" -> q="taro@example.com"
  - "Most recently active contacts" -> sort="last_activity_at", sort_direction="desc"
  - "Contacts labeled 'lead'" -> labels=["lead"]`,
      inputSchema: z.strictObject({
        q: z.string().trim().min(1).max(200).optional().describe("Search text (name, email, phone number, identifier)"),
        labels: LabelsSchema.optional().describe("Contacts having ANY of these labels (ignored when q is given)"),
        sort: z.enum(SORT_FIELDS).optional().describe("Sort field (default: API order)"),
        sort_direction: z.enum(["asc", "desc"]).default("asc").describe("Sort direction when sort is set (default 'asc')"),
        page: PageSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: PagedOutputSchema(z.record(z.string(), z.unknown())),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ q, labels, sort, sort_direction, page, response_format }) => {
      try {
        const sortParam = sort ? `${sort_direction === "desc" ? "-" : ""}${sort}` : undefined;
        const data = q
          ? await client.get<ContactListResponse>("/contacts/search", { query: { q, sort: sortParam, page } })
          : await client.get<ContactListResponse>("/contacts", { query: { labels, sort: sortParam, page } });
        return contactListResult(q ? `Contacts matching '${q}'` : "Contacts", data, page, response_format, ctx);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_filter_contacts",
    {
      title: "Filter Chatwoot Contacts",
      description: `Find contacts matching advanced conditions (the contact "Filter" panel in Chatwoot). Read-only.

Standard attribute_key values and their operators:
  - name, email, identifier, country_code, city, company_name: equal_to, not_equal_to, contains, does_not_contain
  - phone_number: equal_to, not_equal_to, contains, does_not_contain, starts_with
  - labels: equal_to, not_equal_to, is_present, is_not_present
  - created_at, last_activity_at: is_greater_than, is_less_than (values ["YYYY-MM-DD"]), days_before (values [N])
  - blocked: equal_to (values [true] or [false])
Custom contact attributes: use the attribute key with custom_attribute_type="contact_attribute"
(definitions: chatwoot_list_records resource="custom_attribute_definitions", attribute_model="contact_attribute").

Conditions are evaluated in order; query_operator joins each condition with the next one.
Page size is fixed at ${PAGE_SIZE.contacts}. Returns the same item shape as chatwoot_list_contacts.

Examples:
  - "Contacts from Japan created after 2026-09-01" -> [{attribute_key:"country_code",filter_operator:"equal_to",values:["JP"]},{attribute_key:"created_at",filter_operator:"is_greater_than",values:["2026-09-01"]}]
  - "Gmail users or anyone at ComeGin" -> [{attribute_key:"email",filter_operator:"contains",values:["gmail.com"],query_operator:"OR"},{attribute_key:"company_name",filter_operator:"contains",values:["ComeGin"]}]`,
      inputSchema: z.strictObject({
        conditions: z.array(FilterConditionSchema).min(1).max(20).describe("Filter conditions, evaluated in order"),
        page: PageSchema,
        response_format: ResponseFormatSchema,
      }),
      outputSchema: PagedOutputSchema(z.record(z.string(), z.unknown())),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ conditions, page, response_format }) => {
      try {
        const data = await client.request<ContactListResponse>("POST", "/contacts/filter", { payload: toFilterPayload(conditions) }, { query: { page } });
        return contactListResult("Filtered contacts", data, page, response_format, ctx);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_get_contact",
    {
      title: "Get Chatwoot Contact",
      description: `Get every field of one contact: name, email, phone, identifier, additional attributes (company, city, country, social profiles),
custom attributes, and the inboxes the contact belongs to (with source_id). Read-only.

Related data: chatwoot_get_related with resource="contact" (conversations, labels, contactable_inboxes).`,
      inputSchema: z.strictObject({
        contact_id: IdSchema("Contact"),
        response_format: ResponseFormatSchema,
      }),
      outputSchema: z.object({ contact: z.record(z.string(), z.unknown()) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ contact_id, response_format }) => {
      try {
        const data = await client.get<{ payload: ChatwootContact }>(`/contacts/${contact_id}`);
        const contact = toContactDetail(data.payload, ctx.tz);
        return formattedResult({ contact }, response_format, () => renderContactDetail(contact), "Use response_format='json'.");
      } catch (error) {
        return errorResult(error, CONTACT_NOT_FOUND);
      }
    },
  );
}

export function renderContactDetail(contact: ApiRecord): string {
  const { id, name, ...rest } = contact;
  return [`# ${String(name ?? "(no name)")} (Contact ID: ${String(id)})`, "", ...renderFields(rest)].join("\n");
}
