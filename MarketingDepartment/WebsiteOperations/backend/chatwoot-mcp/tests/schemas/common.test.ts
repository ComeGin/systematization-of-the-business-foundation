import { describe, expect, it } from "vitest";

import { ConversationIdSchema, DateTimeSchema, FilterConditionSchema, LabelsSchema, PageSchema, toFilterPayload } from "../../src/schemas/common.js";

describe("toFilterPayload", () => {
  const conditions = [
    FilterConditionSchema.parse({ attribute_key: "status", filter_operator: "equal_to", values: ["open"], query_operator: "OR" }),
    FilterConditionSchema.parse({ attribute_key: "plan", filter_operator: "equal_to", values: ["pro"], custom_attribute_type: "conversation_attribute" }),
  ];

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
});

describe("FilterConditionSchema", () => {
  it("values の既定は空配列、query_operator の既定は AND", () => {
    expect(FilterConditionSchema.parse({ attribute_key: "labels", filter_operator: "is_present" })).toEqual({
      attribute_key: "labels",
      filter_operator: "is_present",
      values: [],
      query_operator: "AND",
    });
  });

  it("未知のキーや演算子は拒否する", () => {
    expect(FilterConditionSchema.safeParse({ attribute_key: "x", filter_operator: "equal_to", extra: 1 }).success).toBe(false);
    expect(FilterConditionSchema.safeParse({ attribute_key: "x", filter_operator: "like" }).success).toBe(false);
  });
});

describe("DateTimeSchema", () => {
  it.each(["2026-09-16", "2026-09-16T09:00", "2026-09-16T09:00:00", "2026-09-16T09:00:00.123Z", "2026-09-16T09:00:00+09:00", " 2026-09-16 "])(
    "%s を受け付ける",
    (value) => {
      expect(DateTimeSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(["2026/09/16", "16-09-2026", "2026-09-16 09:00", "yesterday", "2026-9-1"])("%s を拒否する", (value) => {
    expect(DateTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe("その他のスキーマ", () => {
  it("会話 ID は正の整数（UI の #番号）に限る", () => {
    expect(ConversationIdSchema.safeParse(42).success).toBe(true);
    for (const value of [0, -1, 1.5, "42"]) expect(ConversationIdSchema.safeParse(value).success).toBe(false);
  });

  it("page の既定は 1 で、0 は拒否する", () => {
    expect(PageSchema.parse(undefined)).toBe(1);
    expect(PageSchema.safeParse(0).success).toBe(false);
  });

  it("ラベルは空文字を拒否し、前後の空白を除く", () => {
    expect(LabelsSchema.parse([" billing "])).toEqual(["billing"]);
    expect(LabelsSchema.safeParse(["  "]).success).toBe(false);
  });
});
