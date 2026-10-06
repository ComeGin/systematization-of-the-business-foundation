import { describe, expect, it } from "vitest";
import * as z from "zod/v4";

import {
  DateSchema,
  IdSchema,
  IncludeLongTextSchema,
  LimitSchema,
  OffsetSchema,
  PagedOutputSchema,
  ResponseFormatSchema,
} from "../../src/schemas/common.js";

describe("ResponseFormatSchema", () => {
  it("既定は markdown で、markdown / json 以外は拒否する", () => {
    expect(ResponseFormatSchema.parse(undefined)).toBe("markdown");
    expect(ResponseFormatSchema.parse("json")).toBe("json");
    expect(ResponseFormatSchema.safeParse("html").success).toBe(false);
  });
});

describe("LimitSchema", () => {
  const schema = LimitSchema(100, 20);

  it("未指定なら既定値を使う", () => {
    expect(schema.parse(undefined)).toBe(20);
  });

  it("1 と上限ちょうどは通し、0・上限超・小数は拒否する", () => {
    expect(schema.parse(1)).toBe(1);
    expect(schema.parse(100)).toBe(100);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(101).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
  });
});

describe("OffsetSchema", () => {
  it("既定は 0 で、負の値は拒否する", () => {
    expect(OffsetSchema.parse(undefined)).toBe(0);
    expect(OffsetSchema.parse(0)).toBe(0);
    expect(OffsetSchema.safeParse(-1).success).toBe(false);
  });
});

describe("IdSchema", () => {
  it("正の整数だけを通す（パスに埋め込むため 0・負・小数・文字列は拒否）", () => {
    const schema = IdSchema("Record");
    expect(schema.parse(1)).toBe(1);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(-3).success).toBe(false);
    expect(schema.safeParse(2.5).success).toBe(false);
    expect(schema.safeParse("1").success).toBe(false);
    expect(schema.safeParse("1/delete").success).toBe(false);
  });
});

describe("IncludeLongTextSchema", () => {
  it("既定は false", () => {
    expect(IncludeLongTextSchema.parse(undefined)).toBe(false);
  });
});

describe("DateSchema", () => {
  it("YYYY-MM-DD だけを通す", () => {
    expect(DateSchema.parse("2026-08-31")).toBe("2026-08-31");
    expect(DateSchema.safeParse("2026-8-31").success).toBe(false);
    expect(DateSchema.safeParse("2026-08-31T00:00:00Z").success).toBe(false);
    expect(DateSchema.safeParse("2026/08/31").success).toBe(false);
  });
});

describe("PagedOutputSchema", () => {
  const schema = PagedOutputSchema(z.number());

  it("next_offset と truncation_message は省略できる", () => {
    expect(schema.safeParse({ total: 1, count: 1, offset: 0, has_more: false, items: [1] }).success).toBe(true);
  });

  it("items の要素は渡したスキーマで検証する", () => {
    expect(schema.safeParse({ total: 1, count: 1, offset: 0, has_more: false, items: ["x"] }).success).toBe(false);
  });
});
