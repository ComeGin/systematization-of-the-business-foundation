import type { McpServer } from "@modelcontextprotocol/server";

import { CHARACTER_LIMIT } from "../constants.js";
import {
  ContactDetailSchema,
  GetContactInputSchema,
  ListContactsInputSchema,
  ListContactsOutputSchema,
  type ContactOrderColumn,
  type ListContactsInput,
  type ListContactsOutput,
} from "../schemas/contacts.js";
import { renderContactDetail, renderContactList, toContactDetail, toContactSummary } from "../services/format.js";
import { describeError, type MauticClient } from "../services/mautic-client.js";
import type { MauticContact, MauticContactListResponse, MauticContactResponse } from "../types.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function errorResult(error: unknown) {
  return { content: [{ type: "text" as const, text: describeError(error) }], isError: true };
}

const ORDER_VALUE: Record<ContactOrderColumn, (contact: MauticContact) => unknown> = {
  id: (contact) => contact.id,
  points: (contact) => contact.points,
  date_added: (contact) => contact.dateAdded,
  date_modified: (contact) => contact.dateModified,
  last_active: (contact) => contact.lastActive,
  email: (contact) => contact.fields.all.email,
  firstname: (contact) => contact.fields.all.firstname,
  lastname: (contact) => contact.fields.all.lastname,
};

/**
 * Mautic は contacts を ID をキーにしたオブジェクトで返すため、JSON.parse の時点で
 * 整数キーが昇順に並び替わり、API 側の並び順が失われる。同じ条件でページ内を並べ直す。
 * NULL の扱いは MySQL に合わせる（ASC で先頭、DESC で末尾）。
 */
function sortContacts(contacts: MauticContact[], column: ContactOrderColumn, direction: "asc" | "desc"): MauticContact[] {
  const valueOf = ORDER_VALUE[column];
  const compareAsc = (a: MauticContact, b: MauticContact): number => {
    const [x, y] = [valueOf(a), valueOf(b)];
    const xEmpty = x === null || x === undefined || x === "";
    const yEmpty = y === null || y === undefined || y === "";
    if (xEmpty || yEmpty) return xEmpty === yEmpty ? 0 : xEmpty ? -1 : 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    // 日時は ISO 8601（同一オフセット）なので文字列比較で順序が保たれる
    return String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
  };
  return [...contacts].sort((a, b) => (direction === "asc" ? compareAsc(a, b) : compareAsc(b, a)));
}

async function listContacts(client: MauticClient, params: ListContactsInput): Promise<ListContactsOutput> {
  const data = await client.get<MauticContactListResponse>("/contacts", {
    search: params.search,
    start: params.offset,
    limit: params.limit,
    orderBy: params.order_by,
    orderByDir: params.order_direction.toUpperCase(),
  });

  const contacts = sortContacts(Object.values(data.contacts), params.order_by, params.order_direction).map(toContactSummary);
  const total = Number(data.total);
  const hasMore = total > params.offset + contacts.length;
  return {
    total,
    count: contacts.length,
    offset: params.offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: params.offset + contacts.length } : {}),
    contacts,
  };
}

/** 応答が CHARACTER_LIMIT を超える場合、件数を半分ずつ減らしてページングを案内する */
function fitToLimit(output: ListContactsOutput, render: (o: ListContactsOutput) => string): [ListContactsOutput, string] {
  let current = output;
  let rendered = render(current);
  while (rendered.length > CHARACTER_LIMIT && current.contacts.length > 1) {
    const contacts = current.contacts.slice(0, Math.ceil(current.contacts.length / 2));
    current = {
      ...current,
      contacts,
      count: contacts.length,
      has_more: true,
      next_offset: current.offset + contacts.length,
      truncation_message: `Response truncated to ${contacts.length} contacts to fit the size limit. Use a smaller limit or offset=${current.offset + contacts.length} to continue.`,
    };
    rendered = render(current);
  }
  return [current, rendered];
}

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
        const render = (output: ListContactsOutput) =>
          params.response_format === "json" ? JSON.stringify(output, null, 2) : renderContactList(output, params.search);
        const [output, textContent] = fitToLimit(await listContacts(client, params), render);
        return { content: [{ type: "text", text: textContent }], structuredContent: output };
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

Use mautic_list_contacts first if you only know an email or name (e.g. search="email:alice@example.com").
Returns a "Not found" error if the ID does not exist.`,
      inputSchema: GetContactInputSchema,
      outputSchema: ContactDetailSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ contact_id, response_format }) => {
      try {
        const { contact } = await client.get<MauticContactResponse>(`/contacts/${contact_id}`);
        const detail = toContactDetail(contact);
        const textContent = response_format === "json" ? JSON.stringify(detail, null, 2) : renderContactDetail(detail);
        return { content: [{ type: "text", text: textContent }], structuredContent: detail };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
