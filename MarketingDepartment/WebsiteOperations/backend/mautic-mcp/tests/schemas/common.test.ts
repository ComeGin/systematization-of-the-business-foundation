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

// 入力検証のスキーマなので上流（サーバ）は無い。異常系は「入力:」「空入力:」だけ

describe("ResponseFormatSchema", () => {
  describe("正常系", () => {
    it("空入力: 未指定なら markdown", () => {
      expect(ResponseFormatSchema.parse(undefined)).toBe("markdown");
    });

    it("json を通す", () => {
      expect(ResponseFormatSchema.parse("json")).toBe("json");
    });
  });

  describe("異常系", () => {
    it("入力: markdown / json 以外は拒否する", () => {
      expect(ResponseFormatSchema.safeParse("html").success).toBe(false);
      expect(ResponseFormatSchema.safeParse("JSON").success).toBe(false);
    });

    it("空入力: 空文字は拒否する", () => {
      expect(ResponseFormatSchema.safeParse("").success).toBe(false);
    });
  });
});

describe("LimitSchema", () => {
  const schema = LimitSchema(100, 20);

  describe("正常系", () => {
    it("空入力: 未指定なら既定値を使う", () => {
      expect(schema.parse(undefined)).toBe(20);
    });

    it("1 と上限ちょうどは通す", () => {
      expect(schema.parse(1)).toBe(1);
      expect(schema.parse(100)).toBe(100);
    });
  });

  describe("異常系", () => {
    it("入力: 0・上限超・小数は拒否する", () => {
      expect(schema.safeParse(0).success).toBe(false);
      expect(schema.safeParse(101).success).toBe(false);
      expect(schema.safeParse(1.5).success).toBe(false);
    });

    it("入力: 数値の文字列は数値に変換せず拒否する", () => {
      expect(schema.safeParse("10").success).toBe(false);
    });

    it("空入力: null は既定値にせず拒否する", () => {
      expect(schema.safeParse(null).success).toBe(false);
    });
  });
});

describe("OffsetSchema", () => {
  describe("正常系", () => {
    it("空入力: 既定は 0", () => {
      expect(OffsetSchema.parse(undefined)).toBe(0);
      expect(OffsetSchema.parse(0)).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: 負の値・小数は拒否する", () => {
      expect(OffsetSchema.safeParse(-1).success).toBe(false);
      expect(OffsetSchema.safeParse(0.5).success).toBe(false);
    });
  });
});

describe("IdSchema", () => {
  const schema = IdSchema("Record");

  describe("正常系", () => {
    it("正の整数を通す", () => {
      expect(schema.parse(1)).toBe(1);
    });
  });

  describe("異常系", () => {
    it("入力: 0・負・小数・文字列は拒否する（パスに埋め込むため）", () => {
      expect(schema.safeParse(0).success).toBe(false);
      expect(schema.safeParse(-3).success).toBe(false);
      expect(schema.safeParse(2.5).success).toBe(false);
      expect(schema.safeParse("1").success).toBe(false);
      expect(schema.safeParse("1/delete").success).toBe(false);
    });

    it("空入力: 未指定・空文字は拒否する", () => {
      expect(schema.safeParse(undefined).success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
    });
  });
});

describe("IncludeLongTextSchema", () => {
  describe("正常系", () => {
    it("空入力: 既定は false", () => {
      expect(IncludeLongTextSchema.parse(undefined)).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: 文字列の true は拒否する", () => {
      expect(IncludeLongTextSchema.safeParse("true").success).toBe(false);
    });
  });
});

describe("DateSchema", () => {
  describe("正常系", () => {
    it("YYYY-MM-DD を通す", () => {
      expect(DateSchema.parse("2026-08-31")).toBe("2026-08-31");
    });
  });

  describe("異常系", () => {
    it("入力: YYYY-MM-DD 以外の形式は拒否する", () => {
      expect(DateSchema.safeParse("2026-8-31").success).toBe(false);
      expect(DateSchema.safeParse("2026-08-31T00:00:00Z").success).toBe(false);
      expect(DateSchema.safeParse("2026/08/31").success).toBe(false);
    });

    it("空入力: 空文字は拒否する", () => {
      expect(DateSchema.safeParse("").success).toBe(false);
    });
  });
});

describe("PagedOutputSchema", () => {
  const schema = PagedOutputSchema(z.number());

  describe("正常系", () => {
    it("next_offset と truncation_message は省略できる", () => {
      expect(schema.safeParse({ total: 1, count: 1, offset: 0, has_more: false, items: [1] }).success).toBe(true);
    });

    it("空入力: items が空配列でも通す", () => {
      expect(schema.safeParse({ total: 0, count: 0, offset: 0, has_more: false, items: [] }).success).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: items の要素は渡したスキーマで検証する", () => {
      expect(schema.safeParse({ total: 1, count: 1, offset: 0, has_more: false, items: ["x"] }).success).toBe(false);
    });

    it("空入力: 空のオブジェクトは拒否する", () => {
      expect(schema.safeParse({}).success).toBe(false);
    });
  });
});
