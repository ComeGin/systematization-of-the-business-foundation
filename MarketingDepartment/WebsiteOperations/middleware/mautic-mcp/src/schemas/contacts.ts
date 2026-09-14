import * as z from "zod/v4";

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' (default) for a readable summary, 'json' for machine-readable output");

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
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum contacts to return (1-100, default 20)"),
  offset: z.number().int().min(0).default(0).describe("Number of contacts to skip for pagination (default 0)"),
  order_by: z.enum(CONTACT_ORDER_COLUMNS).default("last_active").describe("Sort column (default 'last_active')"),
  order_direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction (default 'desc')"),
  response_format: ResponseFormatSchema,
});

export const GetContactInputSchema = z.strictObject({
  contact_id: z.number().int().positive().describe("Mautic contact ID (e.g. 42). Find IDs with mautic_list_contacts."),
  response_format: ResponseFormatSchema,
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

export const ListContactsOutputSchema = z.object({
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
  truncation_message: z.string().optional(),
  contacts: z.array(ContactSummarySchema),
});

export const ContactDetailSchema = ContactSummarySchema.extend({
  date_modified: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()).describe("All non-empty custom and core fields, keyed by field alias"),
  do_not_contact: z.array(
    z.object({ channel: z.string(), reason: z.string(), comments: z.string().nullable() }),
  ),
});

export type ContactOrderColumn = (typeof CONTACT_ORDER_COLUMNS)[number];
export type ListContactsInput = z.infer<typeof ListContactsInputSchema>;
export type ContactSummary = z.infer<typeof ContactSummarySchema>;
export type ListContactsOutput = z.infer<typeof ListContactsOutputSchema>;
export type ContactDetail = z.infer<typeof ContactDetailSchema>;
