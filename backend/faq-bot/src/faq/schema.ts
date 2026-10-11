import * as z from "zod/v4";

// faq.json の形（I-33 の契約。正本は frontend/verdant-virgo/src/modules/faq-export。仕様 5 節）
export const FaqItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(4_000),
  // 回答の後ろにそのまま出すため、http・https 以外を通さない
  url: z.url({ protocol: /^https?$/ }),
  context: z.string().trim().min(1).max(50).nullish().transform((value) => value ?? null),
});

export type FaqItem = z.infer<typeof FaqItemSchema>;

export const FaqDocumentSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  items: z
    .array(FaqItemSchema)
    .min(1)
    .max(500)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "id が重複している"),
});
