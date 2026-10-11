import { describe, expect, it } from "vitest";

import {
  CONTACT_RELATIONS,
  GetContactActivityInputSchema,
  GetContactInputSchema,
  GetContactRelationsInputSchema,
  ListContactsInputSchema,
} from "../../src/schemas/contacts.js";

// 入力検証のスキーマなので上流（サーバ）は無い。異常系は「入力:」「空入力:」だけ

describe("ListContactsInputSchema", () => {
  describe("正常系", () => {
    it("空入力: 未指定の項目に既定値を入れる（最終アクティブの新しい順に 20 件）", () => {
      expect(ListContactsInputSchema.parse({})).toEqual({
        limit: 20,
        offset: 0,
        order_by: "last_active",
        order_direction: "desc",
        response_format: "markdown",
      });
    });

    it("search の前後の空白を除く", () => {
      expect(ListContactsInputSchema.parse({ search: "  tag:vip  " }).search).toBe("tag:vip");
    });

    it("空入力: search が空白だけなら空文字にする（検索しないのと同じ）", () => {
      expect(ListContactsInputSchema.parse({ search: "   " }).search).toBe("");
    });

    it("order_by は許可した列名を受け付ける", () => {
      expect(ListContactsInputSchema.parse({ order_by: "points" }).order_by).toBe("points");
    });

    it("limit は 100 まで通す", () => {
      expect(ListContactsInputSchema.safeParse({ limit: 100 }).success).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: search が 200 文字を超えたら拒否する", () => {
      expect(ListContactsInputSchema.safeParse({ search: "a".repeat(201) }).success).toBe(false);
    });

    it("入力: order_by は許可した列名以外を受け付けない（任意の SQL を通さない）", () => {
      expect(ListContactsInputSchema.safeParse({ order_by: "points; DROP TABLE leads" }).success).toBe(false);
      expect(ListContactsInputSchema.safeParse({ order_by: "lastActive" }).success).toBe(false);
    });

    it("入力: 未知のキーは拒否する", () => {
      expect(ListContactsInputSchema.safeParse({ page: 2 }).success).toBe(false);
    });

    it("入力: limit が 100 を超えたら拒否する", () => {
      expect(ListContactsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    });
  });
});

describe("GetContactInputSchema", () => {
  describe("正常系", () => {
    it("contact_id を受け付け、response_format は markdown を既定にする", () => {
      expect(GetContactInputSchema.parse({ contact_id: 42 })).toEqual({ contact_id: 42, response_format: "markdown" });
    });
  });

  describe("異常系", () => {
    it("空入力: contact_id がなければ拒否する", () => {
      expect(GetContactInputSchema.safeParse({}).success).toBe(false);
    });

    it("入力: contact_id が文字列・0 なら拒否する", () => {
      expect(GetContactInputSchema.safeParse({ contact_id: "42" }).success).toBe(false);
      expect(GetContactInputSchema.safeParse({ contact_id: 0 }).success).toBe(false);
    });
  });
});

describe("GetContactActivityInputSchema", () => {
  describe("正常系", () => {
    it("既定は新しい順に 25 件の 1 ページ目", () => {
      expect(GetContactActivityInputSchema.parse({ contact_id: 1 })).toMatchObject({ limit: 25, page: 1, order_direction: "desc" });
    });

    it("イベント種別の配列は 20 件まで通す", () => {
      const types = Array.from({ length: 20 }, (_, i) => `t${i}`);
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, include_event_types: types }).success).toBe(true);
    });

    it("空入力: イベント種別が空配列でも通す", () => {
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, include_event_types: [] }).success).toBe(true);
    });

    it("日付は YYYY-MM-DD を通す", () => {
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, date_from: "2026-08-01" }).success).toBe(true);
    });
  });

  describe("異常系", () => {
    it("入力: イベント種別の配列が 21 件以上なら拒否する", () => {
      const types = Array.from({ length: 21 }, (_, i) => `t${i}`);
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, include_event_types: types }).success).toBe(false);
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, exclude_event_types: types }).success).toBe(false);
    });

    it("入力: page は 1 以上", () => {
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, page: 0 }).success).toBe(false);
    });

    it("入力: 日付が YYYY-MM-DD でなければ拒否する", () => {
      expect(GetContactActivityInputSchema.safeParse({ contact_id: 1, date_from: "yesterday" }).success).toBe(false);
    });

    it("空入力: contact_id がなければ拒否する", () => {
      expect(GetContactActivityInputSchema.safeParse({}).success).toBe(false);
    });
  });
});

describe("GetContactRelationsInputSchema", () => {
  describe("正常系", () => {
    it("relation は CONTACT_RELATIONS のキーを受け付ける", () => {
      for (const relation of Object.keys(CONTACT_RELATIONS)) {
        expect(GetContactRelationsInputSchema.safeParse({ contact_id: 1, relation }).success, relation).toBe(true);
      }
    });
  });

  describe("異常系", () => {
    it("入力: CONTACT_RELATIONS に無い relation は拒否する", () => {
      expect(GetContactRelationsInputSchema.safeParse({ contact_id: 1, relation: "activity" }).success).toBe(false);
    });

    it("空入力: relation がない・空文字なら拒否する", () => {
      expect(GetContactRelationsInputSchema.safeParse({ contact_id: 1 }).success).toBe(false);
      expect(GetContactRelationsInputSchema.safeParse({ contact_id: 1, relation: "" }).success).toBe(false);
    });
  });
});
