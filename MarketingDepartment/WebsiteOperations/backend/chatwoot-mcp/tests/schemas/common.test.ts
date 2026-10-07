import { describe, expect, it } from "vitest";

import {
  ConversationIdSchema,
  DateTimeSchema,
  FilterConditionSchema,
  IdSchema,
  LabelsSchema,
  PageSchema,
  ResponseFormatSchema,
  toFilterPayload,
} from "../../src/schemas/common.js";

// 入力スキーマと純粋な変換関数だけで、上流（サーバ）を呼ばないため「サーバ:」の異常系は置かない

describe("toFilterPayload", () => {
  const conditions = [
    FilterConditionSchema.parse({ attribute_key: "status", filter_operator: "equal_to", values: ["open"], query_operator: "OR" }),
    FilterConditionSchema.parse({ attribute_key: "plan", filter_operator: "equal_to", values: ["pro"], custom_attribute_type: "conversation_attribute" }),
  ];

  describe("正常系", () => {
    it("最後の条件からは query_operator を取り除く（Chatwoot がエラーにするため）", () => {
      const payload = toFilterPayload(conditions);
      expect(payload[0]).toHaveProperty("query_operator", "OR");
      expect(payload[1]).not.toHaveProperty("query_operator");
    });

    it("custom_attribute_type は指定された条件にだけ付ける", () => {
      const payload = toFilterPayload(conditions);
      expect(payload[0]).not.toHaveProperty("custom_attribute_type");
      expect(payload[1]).toHaveProperty("custom_attribute_type", "conversation_attribute");
    });

    it("条件が 1 つなら query_operator を付けない", () => {
      const [only] = toFilterPayload([conditions[0]!]);
      expect(only).toEqual({ attribute_key: "status", filter_operator: "equal_to", values: ["open"] });
    });

    it("空入力: 条件が 0 件なら空配列を返す", () => {
      expect(toFilterPayload([])).toEqual([]);
    });
  });
});

describe("FilterConditionSchema", () => {
  describe("正常系", () => {
    it("空入力: values を省略すると空配列、query_operator を省略すると AND になる", () => {
      expect(FilterConditionSchema.parse({ attribute_key: "labels", filter_operator: "is_present" })).toEqual({
        attribute_key: "labels",
        filter_operator: "is_present",
        values: [],
        query_operator: "AND",
      });
    });

    it("values には文字列・数値・真偽値を混ぜられる", () => {
      expect(FilterConditionSchema.parse({ attribute_key: "x", filter_operator: "equal_to", values: ["a", 1, true] }).values).toEqual(["a", 1, true]);
    });
  });

  describe("異常系", () => {
    it("入力: 未知のキーや演算子は拒否する", () => {
      expect(FilterConditionSchema.safeParse({ attribute_key: "x", filter_operator: "equal_to", extra: 1 }).success).toBe(false);
      expect(FilterConditionSchema.safeParse({ attribute_key: "x", filter_operator: "like" }).success).toBe(false);
    });

    it("入力: values が 101 件以上・オブジェクトを含むと拒否する", () => {
      expect(FilterConditionSchema.safeParse({ attribute_key: "x", filter_operator: "equal_to", values: Array(101).fill("a") }).success).toBe(false);
      expect(FilterConditionSchema.safeParse({ attribute_key: "x", filter_operator: "equal_to", values: [{ a: 1 }] }).success).toBe(false);
    });

    it("空入力: 空オブジェクト・空白だけの attribute_key は拒否する", () => {
      expect(FilterConditionSchema.safeParse({}).success).toBe(false);
      expect(FilterConditionSchema.safeParse({ attribute_key: "   ", filter_operator: "equal_to" }).success).toBe(false);
    });
  });
});

describe("DateTimeSchema", () => {
  describe("正常系", () => {
    it.each(["2026-09-16", "2026-09-16T09:00", "2026-09-16T09:00:00", "2026-09-16T09:00:00.123Z", "2026-09-16T09:00:00+09:00", " 2026-09-16 "])(
      "%s を受け付ける",
      (value) => {
        expect(DateTimeSchema.safeParse(value).success).toBe(true);
      },
    );
  });

  describe("異常系", () => {
    it.each(["2026/09/16", "16-09-2026", "2026-09-16 09:00", "yesterday", "2026-9-1"])("入力: %s を拒否する", (value) => {
      expect(DateTimeSchema.safeParse(value).success).toBe(false);
    });

    it("空入力: 空文字・空白だけは拒否する", () => {
      expect(DateTimeSchema.safeParse("").success).toBe(false);
      expect(DateTimeSchema.safeParse("   ").success).toBe(false);
    });
  });
});

describe("ConversationIdSchema / IdSchema", () => {
  describe("正常系", () => {
    it("会話 ID は正の整数（UI の #番号）を受け付ける", () => {
      expect(ConversationIdSchema.safeParse(42).success).toBe(true);
      expect(IdSchema("Contact").safeParse(1).success).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: 0・負の数・小数・数字の文字列は拒否する", () => {
      for (const value of [0, -1, 1.5, "42"]) {
        expect(ConversationIdSchema.safeParse(value).success, String(value)).toBe(false);
        expect(IdSchema("Contact").safeParse(value).success, String(value)).toBe(false);
      }
    });

    it("空入力: undefined・null は拒否する", () => {
      expect(ConversationIdSchema.safeParse(undefined).success).toBe(false);
      expect(ConversationIdSchema.safeParse(null).success).toBe(false);
    });
  });
});

describe("PageSchema / ResponseFormatSchema", () => {
  describe("正常系", () => {
    it("空入力: page の既定は 1、response_format の既定は markdown", () => {
      expect(PageSchema.parse(undefined)).toBe(1);
      expect(ResponseFormatSchema.parse(undefined)).toBe("markdown");
    });
  });

  describe("異常系", () => {
    it("入力: page の 0・小数と、未知の response_format は拒否する", () => {
      expect(PageSchema.safeParse(0).success).toBe(false);
      expect(PageSchema.safeParse(1.5).success).toBe(false);
      expect(ResponseFormatSchema.safeParse("html").success).toBe(false);
    });
  });
});

describe("LabelsSchema", () => {
  describe("正常系", () => {
    it("前後の空白を除く", () => {
      expect(LabelsSchema.parse([" billing "])).toEqual(["billing"]);
    });

    it("空入力: 空配列は受け付ける（全ラベルの解除に使う）", () => {
      expect(LabelsSchema.parse([])).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("空入力: 空白だけのラベルは拒否する", () => {
      expect(LabelsSchema.safeParse(["  "]).success).toBe(false);
    });

    it("入力: 256 文字のラベル・101 件以上は拒否する", () => {
      expect(LabelsSchema.safeParse(["a".repeat(256)]).success).toBe(false);
      expect(LabelsSchema.safeParse(Array.from({ length: 101 }, (_, i) => `l${i}`)).success).toBe(false);
    });
  });
});
