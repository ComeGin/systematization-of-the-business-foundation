import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { IdSchema, LimitSchema, OffsetSchema } from "../schemas/common.js";
import type { MauticClient } from "../services/mautic-client.js";
import { errorResult, jsonResult, pagedOutput } from "../services/results.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

const PAGING_HINT = "Use a smaller limit or a larger offset.";

export function registerRelatedTools(server: McpServer, client: MauticClient): void {
  server.registerTool(
    "mautic_list_campaign_contacts",
    {
      title: "List Mautic Campaign Contacts",
      description: `List the contacts that are members of one campaign, with pagination. Read-only.

Returns JSON: { total, count, offset, has_more, next_offset, items: [{ lead_id, date_added, manually_removed, manually_added, date_last_exited, rotation, ... }] }.
Look up member details with mautic_get_contact using lead_id. Find campaign IDs with mautic_list_records (resource="campaigns").`,
      inputSchema: z.strictObject({
        campaign_id: IdSchema("Campaign"),
        limit: LimitSchema(100, 20),
        offset: OffsetSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ campaign_id, limit, offset }) => {
      try {
        const list = await client.getList<unknown>(`/campaigns/${campaign_id}/contacts`, "contacts", { start: offset, limit });
        return jsonResult(pagedOutput(list.total, offset, list.items), PAGING_HINT);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_list_form_submissions",
    {
      title: "List Mautic Form Submissions",
      description: `List submissions of one form (optionally only those from one contact) in Mautic's default order. Read-only.

Returns JSON: { total, count, offset, has_more, next_offset, items: [{ id, dateSubmitted, referer, lead, page, results: { <field alias>: <value> } }] }.
Find form IDs with mautic_list_records (resource="forms").`,
      inputSchema: z.strictObject({
        form_id: IdSchema("Form"),
        contact_id: IdSchema("Contact").optional().describe("Only submissions made by this contact"),
        limit: LimitSchema(100, 20),
        offset: OffsetSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ form_id, contact_id, limit, offset }) => {
      try {
        const path = contact_id ? `/forms/${form_id}/submissions/contact/${contact_id}` : `/forms/${form_id}/submissions`;
        const list = await client.getList<unknown>(path, "submissions", { start: offset, limit });
        return jsonResult(pagedOutput(list.total, offset, list.items), PAGING_HINT);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
