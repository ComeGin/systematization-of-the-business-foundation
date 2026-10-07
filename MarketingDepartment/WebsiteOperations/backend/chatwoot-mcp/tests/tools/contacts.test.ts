import { describe, expect, it } from "vitest";

import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { CONTACT_NOT_FOUND, registerContactTools } from "../../src/tools/contacts.js";
import { installFetch, installFetchFailure, routes, timeoutError, V1 } from "../helpers/fetch.js";
import { ACCESS_TOKEN, contact, createFakeServer, makeCtx, textOf } from "../helpers/server.js";

function setup() {
  const fake = createFakeServer();
  registerContactTools(fake.server, makeCtx());
  return fake;
}

describe("registerContactTools", () => {
  describe("正常系", () => {
    it("参照系 3 ツールを参照専用の注釈で登録する", () => {
      const fake = setup();
      expect(fake.names()).toEqual(["chatwoot_list_contacts", "chatwoot_filter_contacts", "chatwoot_get_contact"]);
      for (const { config } of fake.tools.values()) expect(config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    });
  });
});

describe("chatwoot_list_contacts", () => {
  describe("正常系", () => {
    it("q がないときは GET /contacts にラベルと並び順（降順は先頭に -）を渡す", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/contacts`]: { json: { meta: { count: 0, current_page: 1 }, payload: [] } } }));
      await setup().call("chatwoot_list_contacts", { labels: ["lead"], sort: "last_activity_at", sort_direction: "desc" });
      expect(calls[0]!.query.getAll("labels[]")).toEqual(["lead"]);
      expect(calls[0]!.query.get("sort")).toBe("-last_activity_at");
    });

    it("q があるときは GET /contacts/search を使い、ラベルは送らない", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/contacts/search`]: { json: { meta: { count: 1, current_page: 1, has_more: false }, payload: [contact()] } } }));
      await setup().call("chatwoot_list_contacts", { q: "taro@example.com", labels: ["lead"], sort: "name" });
      expect(calls[0]!.query.get("q")).toBe("taro@example.com");
      expect(calls[0]!.query.get("sort")).toBe("name");
      expect(calls[0]!.query.has("labels[]")).toBe(false);
    });

    it("一覧は meta.count を総件数として、固定ページ件数（15）で続きの有無を決める", async () => {
      installFetch(routes({ [`GET ${V1}/contacts`]: { json: { meta: { count: 16, current_page: 1 }, payload: [contact()] } } }));
      expect((await setup().call("chatwoot_list_contacts")).structuredContent).toMatchObject({ total: 16, has_more: true, next_page: 2 });
    });

    it("検索は meta.has_more を使い、総件数は返さない", async () => {
      installFetch(routes({ [`GET ${V1}/contacts/search`]: { json: { meta: { count: 15, current_page: 1, has_more: true }, payload: [contact()] } } }));
      const structured = (await setup().call("chatwoot_list_contacts", { q: "taro" })).structuredContent as any;
      expect(structured).toMatchObject({ has_more: true, next_page: 2 });
      expect(structured).not.toHaveProperty("total");
    });

    it("空入力: 引数なしで 0 件なら「No contacts found.」を返し、page=1 だけを送る", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/contacts`]: { json: { meta: { count: 0, current_page: 1 }, payload: [] } } }));
      const result = await setup().call("chatwoot_list_contacts", {});
      expect(Object.fromEntries(calls[0]!.query)).toEqual({ page: "1" });
      expect(textOf(result)).toBe("# Contacts\n\nNo contacts found.");
      expect(result.structuredContent).toMatchObject({ count: 0, total: 0, has_more: false, items: [] });
    });

    it("空入力: 空配列のラベルはクエリに載せない", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/contacts`]: { json: { meta: { count: 0, current_page: 1 }, payload: [] } } }));
      await setup().call("chatwoot_list_contacts", { labels: [] });
      expect(calls[0]!.query.has("labels[]")).toBe(false);
    });
  });

  describe("異常系", () => {
    it("空入力: 空白だけの q は入力検証で拒否し、API を呼ばない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await expect(setup().call("chatwoot_list_contacts", { q: "   " })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("入力: 201 文字以上の q・未知の並び順・page=0 は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_contacts", { q: "x".repeat(201) })).rejects.toThrow();
      await expect(setup().call("chatwoot_list_contacts", { sort: "password" })).rejects.toThrow();
      await expect(setup().call("chatwoot_list_contacts", { page: 0 })).rejects.toThrow();
    });

    it("サーバ: 429 は待ってから再試行するよう伝える", async () => {
      installFetch(() => ({ status: 429, json: { error: "Too many requests" } }));
      const result = await setup().call("chatwoot_list_contacts");
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Error: Rate limit exceeded. Wait a moment before retrying.");
    });

    it("サーバ: 401（権限不足）はロールの問題として伝え、トークンを含めない", async () => {
      installFetch(() => ({ status: 401, json: { error: "You are not authorized to do this action" } }));
      const text = textOf(await setup().call("chatwoot_list_contacts", { q: "taro" }));
      expect(text).toContain("Permission denied");
      expect(text).not.toContain(ACCESS_TOKEN);
    });

    it("サーバ: 想定外の形の応答（meta・payload なし）は例外にせず isError で返す", async () => {
      installFetch(routes({ [`GET ${V1}/contacts`]: { json: {} } }));
      expect((await setup().call("chatwoot_list_contacts")).isError).toBe(true);
    });
  });
});

describe("chatwoot_filter_contacts", () => {
  describe("正常系", () => {
    it("POST /contacts/filter に条件を送る", async () => {
      const { calls } = installFetch(routes({ [`POST ${V1}/contacts/filter`]: { json: { meta: { count: 0, current_page: 1 }, payload: [] } } }));
      await setup().call("chatwoot_filter_contacts", {
        conditions: [{ attribute_key: "country_code", filter_operator: "equal_to", values: ["JP"] }],
      });
      expect(calls[0]!.query.get("page")).toBe("1");
      expect(calls[0]!.body).toEqual({ payload: [{ attribute_key: "country_code", filter_operator: "equal_to", values: ["JP"] }] });
    });

    it("空入力: 一致する連絡先が 0 件なら「No contacts found.」を返す", async () => {
      installFetch(routes({ [`POST ${V1}/contacts/filter`]: { json: { meta: { count: 0, current_page: 1 }, payload: [] } } }));
      const result = await setup().call("chatwoot_filter_contacts", { conditions: [{ attribute_key: "labels", filter_operator: "is_present" }] });
      expect(textOf(result)).toBe("# Filtered contacts\n\nNo contacts found.");
    });
  });

  describe("異常系", () => {
    it("空入力: 条件が空配列なら入力検証で拒否し、API を呼ばない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await expect(setup().call("chatwoot_filter_contacts", { conditions: [] })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("入力: 21 件以上の条件は入力検証で拒否する", async () => {
      const conditions = Array.from({ length: 21 }, () => ({ attribute_key: "labels", filter_operator: "is_present" }));
      await expect(setup().call("chatwoot_filter_contacts", { conditions })).rejects.toThrow();
    });

    it("サーバ: 422（未知の属性など）は Chatwoot の拒否理由を返す", async () => {
      installFetch(() => ({ status: 422, json: { error: "Invalid attribute key - [foo]" } }));
      const result = await setup().call("chatwoot_filter_contacts", { conditions: [{ attribute_key: "foo", filter_operator: "equal_to", values: ["x"] }] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("rejected the request (Invalid attribute key - [foo])");
    });

    it("サーバ: タイムアウトは絞り込みの案内を返す", async () => {
      installFetchFailure(timeoutError());
      const result = await setup().call("chatwoot_filter_contacts", { conditions: [{ attribute_key: "labels", filter_operator: "is_present" }] });
      expect(textOf(result)).toContain("did not respond within");
    });
  });
});

describe("chatwoot_get_contact", () => {
  describe("正常系", () => {
    it("GET /contacts/{id} の payload を詳細にし、追加属性の秘匿情報を伏せる", async () => {
      const { calls } = installFetch(
        routes({ [`GET ${V1}/contacts/12`]: { json: { payload: contact({ additional_attributes: { company_name: "Example", session_token: "t" } }) } } }),
      );
      const result = await setup().call("chatwoot_get_contact", { contact_id: 12, response_format: "json" });
      expect(calls).toHaveLength(1);
      expect((result.structuredContent as any).contact).toMatchObject({ id: 12, additional_attributes: { company_name: "Example", session_token: "[redacted]" } });
    });

    it("空入力: 名前のない連絡先は Markdown の見出しを (no name) にする", async () => {
      installFetch(routes({ [`GET ${V1}/contacts/12`]: { json: { payload: contact({ name: null, email: null }) } } }));
      expect(textOf(await setup().call("chatwoot_get_contact", { contact_id: 12 }))).toContain("# (no name) (Contact ID: 12)");
    });
  });

  describe("異常系", () => {
    it("空入力: contact_id がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_get_contact", {})).rejects.toThrow();
    });

    it("入力: contact_id が 0・文字列なら入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_get_contact", { contact_id: 0 })).rejects.toThrow();
      await expect(setup().call("chatwoot_get_contact", { contact_id: "12" })).rejects.toThrow();
    });

    it("サーバ: 404 はコンタクトの探し方を案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "not found" } }));
      const result = await setup().call("chatwoot_get_contact", { contact_id: 99 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(CONTACT_NOT_FOUND);
    });

    it("サーバ: 5xx は詳細を含めずにサーバエラーとして返す", async () => {
      installFetch(() => ({ status: 503, json: { error: "internal stack" } }));
      const text = textOf(await setup().call("chatwoot_get_contact", { contact_id: 12 }));
      expect(text).toContain("Chatwoot server error (503)");
      expect(text).not.toContain("internal stack");
    });
  });
});
