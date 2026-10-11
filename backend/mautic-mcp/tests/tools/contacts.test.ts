import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT } from "../../src/constants.js";
import { MauticApiError } from "../../src/services/mautic-client.js";
import { registerContactTools } from "../../src/tools/contacts.js";
import type { MauticContact } from "../../src/types.js";
import { createFakeClient, createFakeServer, SERVER_ERRORS } from "../helpers/fake-server.js";

function setup() {
  const fake = createFakeServer();
  const client = createFakeClient();
  registerContactTools(fake.server, client.client);
  return { ...fake, ...client };
}

function contact(id: number, fields: Record<string, unknown> = {}): MauticContact {
  return {
    id,
    dateAdded: "2026-01-01",
    dateModified: "2026-01-02",
    lastActive: null,
    points: 0,
    owner: null,
    stage: null,
    tags: [],
    fields: { all: { id, email: `c${id}@example.com`, firstname: `F${id}`, lastname: "", company: "", ...fields } },
  };
}

describe("registerContactTools", () => {
  describe("正常系", () => {
    it("コンタクト系の 4 ツールを参照専用の annotation で登録する", () => {
      const { tools } = setup();
      expect([...tools.keys()].sort()).toEqual([
        "mautic_get_contact",
        "mautic_get_contact_activity",
        "mautic_get_contact_relations",
        "mautic_list_contacts",
      ]);
      for (const [name, tool] of tools) {
        expect(tool.config.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
    });
  });
});

describe("mautic_list_contacts", () => {
  describe("正常系", () => {
    it("検索・ページング・並び順を Mautic のクエリ名に変換して呼ぶ（方向は大文字）", async () => {
      const { call, getList } = setup();
      getList.mockResolvedValue({ total: 0, items: [], meta: {} });
      await call("mautic_list_contacts", { search: "tag:vip", offset: 40, limit: 10, order_by: "points", order_direction: "asc" });
      expect(getList).toHaveBeenCalledWith("/contacts", "contacts", {
        search: "tag:vip",
        start: 40,
        limit: 10,
        orderBy: "points",
        orderByDir: "ASC",
      });
    });

    it("空入力: 引数なしなら既定値（20 件・last_active の降順）で呼ぶ", async () => {
      const { call, getList } = setup();
      getList.mockResolvedValue({ total: 0, items: [], meta: {} });
      await call("mautic_list_contacts");
      expect(getList).toHaveBeenCalledWith("/contacts", "contacts", {
        search: undefined,
        start: 0,
        limit: 20,
        orderBy: "last_active",
        orderByDir: "DESC",
      });
    });

    it("空入力: 0 件の応答なら件数だけの Markdown と、items が空の structuredContent を返す", async () => {
      const { call, getList } = setup();
      getList.mockResolvedValue({ total: 0, items: [], meta: {} });
      const result = await call("mautic_list_contacts", { search: "tag:none" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toBe("# Contacts matching 'tag:none'\n\nNo contacts found (total: 0).");
      expect(result.structuredContent).toEqual({ total: 0, count: 0, offset: 0, has_more: false, items: [] });
    });

    it("markdown でも structuredContent には JSON（ページング付きの要約）を入れる", async () => {
      const { call, getList } = setup();
      getList.mockResolvedValue({ total: 5, items: [contact(1), contact(2)], meta: {} });
      const result = await call("mautic_list_contacts", { limit: 2 });

      expect(result.content[0]!.text).toContain("# Contacts");
      expect(result.structuredContent).toMatchObject({ total: 5, count: 2, offset: 0, has_more: true, next_offset: 2 });
      expect((result.structuredContent!.items as { email: string }[]).map((item) => item.email)).toEqual(["c1@example.com", "c2@example.com"]);
    });

    it("response_format=json ならテキストも structuredContent と同じ JSON にする", async () => {
      const { call, getList } = setup();
      getList.mockResolvedValue({ total: 1, items: [contact(1)], meta: {} });
      const result = await call("mautic_list_contacts", { response_format: "json" });
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    });

    it("応答が大きすぎるときは件数を減らし、structuredContent も同じ件数にそろえる", async () => {
      const { call, getList } = setup();
      const items = Array.from({ length: 100 }, (_, i) => contact(i + 1, { company: "c".repeat(400) }));
      getList.mockResolvedValue({ total: 100, items, meta: {} });
      const result = await call("mautic_list_contacts", { limit: 100 });

      const structured = result.structuredContent as { count: number; items: unknown[]; truncation_message?: string };
      expect(result.content[0]!.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
      expect(structured.items.length).toBeLessThan(100);
      expect(structured.count).toBe(structured.items.length);
      expect(structured.truncation_message).toMatch(/^Response truncated to \d+ items/);
    });
  });

  describe("異常系", () => {
    it("入力: 許可していない order_by・上限を超える limit は Mautic を呼ばずに拒否する", async () => {
      const { call, getList } = setup();
      await expect(call("mautic_list_contacts", { order_by: "points; DROP TABLE leads" })).rejects.toThrow();
      await expect(call("mautic_list_contacts", { limit: 101 })).rejects.toThrow();
      expect(getList).not.toHaveBeenCalled();
    });

    it("サーバ: API エラーは isError の結果にする", async () => {
      const { call, getList } = setup();
      getList.mockRejectedValue(new MauticApiError(403, "no access"));
      const result = await call("mautic_list_contacts");
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Permission denied (no access)");
    });

    it.each(SERVER_ERRORS)("サーバ: %s は例外にせず isError の結果にする", async (_label, error, expected) => {
      const { call, getList } = setup();
      getList.mockRejectedValue(error);
      const result = await call("mautic_list_contacts");
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]!.text).toContain(expected);
    });
  });
});

describe("mautic_get_contact", () => {
  describe("正常系", () => {
    it("/contacts/{id} を取得して詳細に整形する", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({ contact: contact(42, { plan: "pro" }) });
      const result = await call("mautic_get_contact", { contact_id: 42 });

      expect(get).toHaveBeenCalledWith("/contacts/42");
      expect(result.structuredContent).toMatchObject({ id: 42, email: "c42@example.com", fields: { plan: "pro" }, do_not_contact: [] });
      expect(result.content[0]!.text).toContain("## F42 (ID: 42)");
    });

    it("response_format=json ならテキストは詳細の JSON", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({ contact: contact(1) });
      const result = await call("mautic_get_contact", { contact_id: 1, response_format: "json" });
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    });
  });

  describe("異常系", () => {
    it("空入力: contact_id がなければ Mautic を呼ばずに拒否する", async () => {
      const { call, get } = setup();
      await expect(call("mautic_get_contact")).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });

    it("入力: contact_id がパスを含む文字列なら拒否する", async () => {
      const { call, get } = setup();
      await expect(call("mautic_get_contact", { contact_id: "1/delete" })).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });

    it("サーバ: 404 は Not found のエラーにする", async () => {
      const { call, get } = setup();
      get.mockRejectedValue(new MauticApiError(404, "Item was not found."));
      const result = await call("mautic_get_contact", { contact_id: 999 });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/^Error: Not found/);
    });

    it.each(SERVER_ERRORS)("サーバ: %s は例外にせず isError の結果にする", async (_label, error, expected) => {
      const { call, get } = setup();
      get.mockRejectedValue(error);
      const result = await call("mautic_get_contact", { contact_id: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(expected);
    });

    it("サーバ: contact を含まない応答（想定外の形）でも例外にせず isError の結果にする", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({});
      const result = await call("mautic_get_contact", { contact_id: 1 });
      expect(result.isError).toBe(true);
    });

    // 整形中の TypeError（toContactDetail(undefined)）は通信失敗ではなく、応答の形が想定外と伝える
    it("サーバ: 想定外の形の応答を、通信失敗（network error）と誤って伝えない", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({});
      const text = (await call("mautic_get_contact", { contact_id: 1 })).content[0]!.text;
      expect(text).toMatch(/^Error: Unexpected response shape from Mautic \(/);
      expect(text).not.toContain("Could not reach");
    });
  });
});

describe("mautic_get_contact_activity", () => {
  describe("正常系", () => {
    it("絞り込みを filters に、並び順を order にまとめて呼ぶ", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({ total: 0, page: 1, maxPages: 0, types: {}, events: [] });
      await call("mautic_get_contact_activity", {
        contact_id: 42,
        include_event_types: ["email.read"],
        date_from: "2026-08-01",
        date_to: "2026-08-31",
        limit: 1,
        order_direction: "asc",
      });
      expect(get).toHaveBeenCalledWith("/contacts/42/activity", {
        filters: { search: undefined, includeEvents: ["email.read"], excludeEvents: undefined, dateFrom: "2026-08-01", dateTo: "2026-08-31" },
        limit: 1,
        page: 1,
        order: ["timestamp", "ASC"],
      });
    });

    it("応答の名前を snake_case に変え、秘匿情報を伏せた JSON を返す", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({
        total: 1,
        page: 1,
        maxPages: 1,
        types: { "email.read": "Email read" },
        events: [{ event: "email.read", details: { token: "abc" } }],
        ignored: true,
      });
      const result = await call("mautic_get_contact_activity", { contact_id: 1 });
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        total: 1,
        page: 1,
        max_pages: 1,
        event_types: { "email.read": "Email read" },
        events: [{ event: "email.read", details: { token: "[redacted]" } }],
      });
    });

    it("空入力: 0 件の応答（events が空）でもエラーにせず JSON を返す", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({ total: 0, page: 1, maxPages: 0, types: {}, events: [] });
      const result = await call("mautic_get_contact_activity", { contact_id: 1 });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual({ total: 0, page: 1, max_pages: 0, event_types: {}, events: [] });
    });
  });

  describe("異常系", () => {
    it("空入力: contact_id がなければ Mautic を呼ばずに拒否する", async () => {
      const { call, get } = setup();
      await expect(call("mautic_get_contact_activity", {})).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });

    it("入力: 日付の形式が違えば Mautic を呼ばずに拒否する", async () => {
      const { call, get } = setup();
      await expect(call("mautic_get_contact_activity", { contact_id: 1, date_from: "2026/08/01" })).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });

    it("サーバ: 空のオブジェクトの応答（想定外の形）でも例外にせず {} を返す", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({});
      const result = await call("mautic_get_contact_activity", { contact_id: 1 });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual({});
    });

    it.each(SERVER_ERRORS)("サーバ: %s は例外にせず isError の結果にする", async (_label, error, expected) => {
      const { call, get } = setup();
      get.mockRejectedValue(error);
      const result = await call("mautic_get_contact_activity", { contact_id: 1 });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(expected);
    });
  });
});

describe("mautic_get_contact_relations", () => {
  describe("正常系", () => {
    it.each([
      ["notes", "/contacts/7/notes"],
      ["segments", "/contacts/7/segments"],
      ["point_groups", "/contacts/7/points/groups"],
    ])("relation=%s は %s を呼ぶ", async (relation, path) => {
      const { call, get } = setup();
      get.mockResolvedValue({ total: 0 });
      await call("mautic_get_contact_relations", { contact_id: 7, relation });
      expect(get).toHaveBeenCalledWith(path);
    });

    it("空入力: 0 件の応答はそのまま JSON で返す", async () => {
      const { call, get } = setup();
      get.mockResolvedValue({ total: 0, notes: [] });
      const result = await call("mautic_get_contact_relations", { contact_id: 7, relation: "notes" });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toEqual({ total: 0, notes: [] });
    });
  });

  describe("異常系", () => {
    it("入力: 未知の relation は入力検証で拒否する", async () => {
      const { call, get } = setup();
      await expect(call("mautic_get_contact_relations", { contact_id: 7, relation: "../users" })).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });

    it("空入力: relation がなければ入力検証で拒否する", async () => {
      const { call, get } = setup();
      await expect(call("mautic_get_contact_relations", { contact_id: 7 })).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });

    it.each(SERVER_ERRORS)("サーバ: %s は例外にせず isError の結果にする", async (_label, error, expected) => {
      const { call, get } = setup();
      get.mockRejectedValue(error);
      const result = await call("mautic_get_contact_relations", { contact_id: 7, relation: "devices" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(expected);
    });
  });
});
