import * as z from "zod/v4";

import { DateSchema, IdSchema, LimitSchema, OffsetSchema, PagedOutputSchema, ResponseFormatSchema } from "./common.js";

// Mautic の orderBy は DB の列名（leads テーブル）で指定する
const CONTACT_ORDER_COLUMNS = ["id", "date_added", "date_modified", "last_active", "email", "firstname", "lastname", "points"] as const;

export const ListContactsInputSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe(
      "Mautic search expression. Plain text matches name/email/company; '%' is the wildcard. Commands: 'email:%@example.com', " +
        "'tag:vip', 'segment:<segment-alias>', 'company:Acme', 'stage:<name>', 'owner:<name>', 'is:anonymous', " +
        "'is:unowned', 'dnc:email'. Prefix '!' to negate (e.g. '!is:anonymous'). Omit to list all contacts.",
    ),
  limit: LimitSchema(100, 20),
  offset: OffsetSchema,
  order_by: z.enum(CONTACT_ORDER_COLUMNS).default("last_active").describe("Sort column (default 'last_active')"),
  order_direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction (default 'desc')"),
  response_format: ResponseFormatSchema,
});

export const GetContactInputSchema = z.strictObject({
  contact_id: IdSchema("Mautic contact").describe("Mautic contact ID (e.g. 42). Find IDs with mautic_list_contacts."),
  response_format: ResponseFormatSchema,
});

export const GetContactActivityInputSchema = z.strictObject({
  contact_id: IdSchema("Mautic contact"),
  search: z.string().trim().max(200).optional().describe("Free text to match in event names/details"),
  include_event_types: z
    .array(z.string().max(100))
    .max(20)
    .optional()
    .describe("Only these event types, e.g. ['email.read', 'page.hit', 'form.submitted']. Every response lists available types in event_types."),
  exclude_event_types: z.array(z.string().max(100)).max(20).optional().describe("Event types to leave out"),
  date_from: DateSchema.optional().describe("Only events on or after this date (YYYY-MM-DD)"),
  date_to: DateSchema.optional().describe("Only events on or before this date (YYYY-MM-DD)"),
  limit: LimitSchema(100, 25),
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1 (default 1)"),
  order_direction: z.enum(["asc", "desc"]).default("desc").describe("Timestamp order (default 'desc': newest first)"),
});

export const CONTACT_RELATIONS = {
  notes: { path: "notes", description: "notes written about the contact" },
  segments: { path: "segments", description: "segments the contact belongs to" },
  campaigns: { path: "campaigns", description: "campaigns the contact is a member of" },
  companies: { path: "companies", description: "companies linked to the contact (primary flag included)" },
  devices: { path: "devices", description: "devices the contact used (browser, OS)" },
  point_groups: { path: "points/groups", description: "point scores per point group" },
} as const;

export const GetContactRelationsInputSchema = z.strictObject({
  contact_id: IdSchema("Mautic contact"),
  relation: z
    .enum(Object.keys(CONTACT_RELATIONS) as [keyof typeof CONTACT_RELATIONS, ...(keyof typeof CONTACT_RELATIONS)[]])
    .describe(Object.entries(CONTACT_RELATIONS).map(([name, relation]) => `'${name}': ${relation.description}`).join("; ")),
});

export const ContactSummarySchema = z.object({
  id: z.number(),
  email: z.string().nullable(),
  firstname: z.string().nullable(),
  lastname: z.string().nullable(),
  company: z.string().nullable(),
  points: z.number(),
  stage: z.string().nullable(),
  owner: z.string().nullable(),
  tags: z.array(z.string()),
  last_active: z.string().nullable(),
  date_added: z.string().nullable(),
});

export const ListContactsOutputSchema = PagedOutputSchema(ContactSummarySchema);

export const ContactDetailSchema = ContactSummarySchema.extend({
  date_modified: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()).describe("All non-empty custom and core fields, keyed by field alias"),
  do_not_contact: z.array(
    z.object({ channel: z.string(), reason: z.string(), comments: z.string().nullable() }),
  ),
});

export type ContactSummary = z.infer<typeof ContactSummarySchema>;
export type ListContactsOutput = z.infer<typeof ListContactsOutputSchema>;
export type ContactDetail = z.infer<typeof ContactDetailSchema>;
