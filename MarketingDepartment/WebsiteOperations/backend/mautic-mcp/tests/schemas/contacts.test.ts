import { describe, expect, it } from "vitest";

import {
  CONTACT_RELATIONS,
  GetContactActivityInputSchema,
  GetContactInputSchema,
  GetContactRelationsInputSchema,
  ListContactsInputSchema,
} from "../../src/schemas/contacts.js";

describe("ListContactsInputSchema", () => {
  it("未指定の項目に既定値を入れる（最終アクティブの新しい順に 20 件）", () => {
    expect(ListContactsInputSchema.parse({})).toEqual({
      limit: 20,
      offset: 0,
      order_by: "last_active",
      order_direction: "desc",
      response_format: "markdown",
    });
  });

  it("search の前後の空白を除き、200 文字を超えたら拒否する", () => {
    expect(ListContactsInputSchema.parse({ search: "  tag:vip  " }).search).toBe("tag:vip");
    expect(ListContactsInputSchema.safeParse({ search: "a".repeat(201) }).success).toBe(false);
  });

  it("order_by は許可した列名だけを受け付ける（任意の SQL を通さない）", () => {
    expect(ListContactsInputSchema.parse({ order_by: "points" }).order_by).toBe("points");
    expect(ListContactsInputSchema.safeParse({ order_by: "points; DROP TABLE leads" }).success).toBe(false);
    expect(ListContactsInputSchema.safeParse({ order_by: "lastActive" }).success).toBe(false);
  });

  it("未知のキーは拒否する", () => {
    expect(ListContactsInputSchema.safeParse({ page: 2 }).success).toBe(false);
  });

  it("limit の上限は 100", () => {
    expect(ListContactsInputSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(ListContactsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("GetContactInputSchema", () => {
  it("contact_id は必須", () => {
    expect(GetContactInputSchema.safeParse({}).success).toBe(false);
    expect(GetContactInputSchema.parse({ contact_id: 42 })).toEqual({ contact_id: 42, response_format: "markdown" });
  });
});

describe("GetContactActivityInputSchema", () => {
  it("既定は新しい順に 25 件の 1 ページ目", () => {
    expect(GetContactActivityInputSchema.parse({ contact_id: 1 })).toMatchObject({ limit: 25, page: 1, order_direction: "desc" });
  });

  it("イベント種別の配列は 20 件まで", () => {
    const types = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, include_event_types: types.slice(0, 20) }).success).toBe(true);
    expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, include_event_types: types }).success).toBe(false);
    expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, exclude_event_types: types }).success).toBe(false);
  });

  it("page は 1 以上", () => {
    expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, page: 0 }).success).toBe(false);
  });

  it("日付は YYYY-MM-DD", () => {
    expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, date_from: "2026-08-01" }).success).toBe(true);
    expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, date_from: "yesterday" }).success).toBe(false);
  });
});

describe("GetContactRelationsInputSchema", () => {
  it("relation は CONTACT_RELATIONS のキーだけを受け付ける", () => {
    for (const relation of Object.keys(CONTACT_RELATIONS)) {
      expect(GetContactRelationsInputSchema.safeParse({ contact_id: 1, relation }).success, relation).toBe(true);
    }
    expect(GetContactRelationsInputSchema.safeParse({ contact_id: 1, relation: "activity" }).success).toBe(false);
  });
});
