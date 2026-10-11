import * as z from "zod/v4";

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' (default) for a readable summary, 'json' for machine-readable output");

export const LimitSchema = (max: number, defaultValue: number) =>
  z.number().int().min(1).max(max).default(defaultValue).describe(`Maximum items to return (1-${max}, default ${defaultValue})`);

export const OffsetSchema = z.number().int().min(0).default(0).describe("Number of items to skip for pagination (default 0)");

export const IdSchema = (what: string) => z.number().int().positive().describe(`${what} ID`);

export const IncludeLongTextSchema = z
  .boolean()
  .default(false)
  .describe("Include long text such as email/page HTML in full (default false: strings over 1000 chars are shortened)");

export const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format");

export const PagedOutputSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    total: z.number(),
    count: z.number(),
    offset: z.number(),
    has_more: z.boolean(),
    next_offset: z.number().optional(),
    truncation_message: z.string().optional(),
    items: z.array(item),
  });
