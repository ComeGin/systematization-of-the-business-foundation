import type { McpServer } from "@modelcontextprotocol/server";

import {
  CONTACT_RELATIONS,
  ContactDetailSchema,
  GetContactActivityInputSchema,
  GetContactInputSchema,
  GetContactRelationsInputSchema,
  ListContactsInputSchema,
  ListContactsOutputSchema,
} from "../schemas/contacts.js";
import { renderContactDetail, renderContactList, toContactDetail, toContactSummary } from "../services/format.js";
import type { MauticClient } from "../services/mautic-client.js";
import { errorResult, fitToLimit, jsonResult, pagedOutput } from "../services/results.js";
import type { MauticContact, MauticContactResponse } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

export function registerContactTools(server: McpServer, client: MauticClient): void {
  server.registerTool(
    "mautic_list_contacts",
    {
      title: "List Mautic Contacts",
      description: `Search and list contacts (leads) in Mautic with pagination. Read-only.

Returns a summary per contact: id, email, firstname, lastname, company, points, stage, owner, tags, last_active, date_added.
Use mautic_get_contact with an id for all fields and do-not-contact status.

Examples:
  - "Contacts from example.com" -> search="email:%@example.com"
  - "VIP contacts in segment 'newsletter'" -> search="tag:vip segment:newsletter"
  - "Most engaged contacts" -> order_by="points", order_direction="desc"
  - "Identified contacts only" -> search="!is:anonymous"

Pagination: when has_more is true, call again with offset=next_offset.`,
      inputSchema: ListContactsInputSchema,
      outputSchema: ListContactsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params) => {
      try {
        const list = await client.getList<MauticContact>("/contacts", "contacts", {
          search: params.search,
          start: params.offset,
          limit: params.limit,
          orderBy: params.order_by,
          orderByDir: params.order_direction.toUpperCase(),
        });
        const [output, text] = fitToLimit(pagedOutput(list.total, params.offset, list.items.map(toContactSummary)), (o) =>
          params.response_format === "json" ? JSON.stringify(o, null, 2) : renderContactList(o, params.search),
        );
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_get_contact",
    {
      title: "Get Mautic Contact",
      description: `Get one Mautic contact by ID with all non-empty fields. Read-only.

Returns the summary fields plus date_modified, fields (every populated core/custom field keyed by alias),
and do_not_contact (channel, reason: unsubscribed/bounced/manual, comments).

Related data: mautic_get_contact_activity (timeline), mautic_get_contact_relations (notes, segments, campaigns, companies, devices, point groups).
Use mautic_list_contacts first if you only know an email or name (e.g. search="email:alice@example.com").`,
      inputSchema: GetContactInputSchema,
      outputSchema: ContactDetailSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ contact_id, response_format }) => {
      try {
        const { contact } = await client.get<MauticContactResponse>(`/contacts/${contact_id}`);
        const detail = toContactDetail(contact);
        const text = response_format === "json" ? JSON.stringify(detail, null, 2) : renderContactDetail(detail);
        return { content: [{ type: "text", text }], structuredContent: detail };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_get_contact_activity",
    {
      title: "Get Mautic Contact Activity",
      description: `Get a contact's activity timeline (email opens, page visits, form submissions, point changes, segment/campaign changes, ...). Read-only.

Returns JSON: { total, page, max_pages, event_types: { "<type>": "<label>" }, events: [{ event, eventLabel, eventType, timestamp, details, ... }] }.
Use event_types from a first call to filter with include_event_types on later calls.

Examples:
  - "When did contact 42 last open an email?" -> contact_id=42, include_event_types=["email.read"], limit=1
  - "What did contact 42 do in August 2026?" -> date_from="2026-08-01", date_to="2026-08-31"`,
      inputSchema: GetContactActivityInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params) => {
      try {
        const data = await client.get<Record<string, unknown>>(`/contacts/${params.contact_id}/activity`, {
          filters: {
            search: params.search,
            includeEvents: params.include_event_types,
            excludeEvents: params.exclude_event_types,
            dateFrom: params.date_from,
            dateTo: params.date_to,
          },
          limit: params.limit,
          page: params.page,
          order: ["timestamp", params.order_direction.toUpperCase()],
        });
        return jsonResult(
          { total: data.total, page: data.page, max_pages: data.maxPages, event_types: data.types, events: data.events },
          "Use a smaller limit, a date range, or include_event_types.",
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_get_contact_relations",
    {
      title: "Get Mautic Contact Relations",
      description: `Get records related to one contact. Read-only.

relation:
${Object.entries(CONTACT_RELATIONS).map(([name, relation]) => `  - ${name}: ${relation.description}`).join("\n")}

Returns the Mautic JSON for that relation (typically { total, <items> }). Secrets are redacted and long text shortened.`,
      inputSchema: GetContactRelationsInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ contact_id, relation }) => {
      try {
        const data = await client.get<unknown>(`/contacts/${contact_id}/${CONTACT_RELATIONS[relation].path}`);
        return jsonResult(data, "This relation has too many entries to show in full.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
