import * as z from "zod/v4";

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' (default) for a readable summary, 'json' for machine-readable output");

export const PageSchema = z.number().int().min(1).default(1).describe("Page number, starting at 1 (default 1)");

export const IdSchema = (what: string) => z.number().int().positive().describe(`${what} ID`);

/** 会話は内部 ID ではなく、アカウント内の表示番号（UI の #123）で指定する */
export const ConversationIdSchema = z.number().int().positive().describe("Conversation ID (the #number shown in the Chatwoot UI)");

export const IncludeLongTextSchema = z
  .boolean()
  .default(false)
  .describe("Include long text such as email bodies in full (default false: strings over 1000 chars are shortened)");

export const DateTimeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/, "Use YYYY-MM-DD or an ISO 8601 date-time")
  .describe("Date (YYYY-MM-DD, in the server's configured time zone) or ISO 8601 date-time");

export const LabelsSchema = z.array(z.string().trim().min(1).max(255)).max(100);

export const CONVERSATION_STATUSES = ["open", "resolved", "pending", "snoozed"] as const;
export const CONVERSATION_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

export const PagedOutputSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    page: z.number(),
    count: z.number(),
    total: z.number().optional(),
    has_more: z.boolean(),
    next_page: z.number().optional(),
    truncation_message: z.string().optional(),
    items: z.array(item),
  });

/** filter API の条件。values は文字列・数値・真偽値の配列 */
export const FilterConditionSchema = z.strictObject({
  attribute_key: z.string().trim().min(1).max(100).describe("Attribute to filter on (see tool description), or a custom attribute key"),
  filter_operator: z
    .enum(["equal_to", "not_equal_to", "contains", "does_not_contain", "is_present", "is_not_present", "is_greater_than", "is_less_than", "days_before", "starts_with"])
    .describe("Comparison operator (allowed operators depend on the attribute)"),
  values: z
    .array(z.union([z.string(), z.number(), z.boolean()]))
    .max(100)
    .default([])
    .describe("Values to compare with. Dates use YYYY-MM-DD; days_before takes a number of days. Empty for is_present / is_not_present"),
  query_operator: z
    .enum(["AND", "OR"])
    .default("AND")
    .describe("How this condition combines with the NEXT one (default AND; ignored on the last condition)"),
  custom_attribute_type: z
    .enum(["conversation_attribute", "contact_attribute"])
    .optional()
    .describe("Set only when attribute_key is a custom attribute"),
});

export type FilterCondition = z.infer<typeof FilterConditionSchema>;

/** Chatwoot は最後の条件に query_operator があるとエラーにするため取り除く */
export function toFilterPayload(conditions: FilterCondition[]): Record<string, unknown>[] {
  return conditions.map(({ query_operator, custom_attribute_type, ...condition }, index) => ({
    ...condition,
    ...(index < conditions.length - 1 ? { query_operator } : {}),
    ...(custom_attribute_type ? { custom_attribute_type } : {}),
  }));
}
