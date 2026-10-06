import { describe, expect, it } from "vitest";

import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { CONTACT_NOT_FOUND, registerContactTools } from "../../src/tools/contacts.js";
import { installFetch, routes, V1 } from "../helpers/fetch.js";
import { contact, createFakeServer, makeCtx, textOf } from "../helpers/server.js";

function setup() {
  const fake = createFakeServer();
  registerContactTools(fake.server, makeCtx());
  return fake;
}

describe("registerContactTools", () => {
  it("参照系 3 ツールを参照専用の注釈で登録する", () => {
    const fake = setup();
    expect(fake.names()).toEqual(["chatwoot_list_contacts", "chatwoot_filter_contacts", "chatwoot_get_contact"]);
    for (const { config } of fake.tools.values()) expect(config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
  });
});

describe("chatwoot_list_contacts", () => {
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
});

describe("chatwoot_filter_contacts", () => {
  it("POST /contacts/filter に条件を送る", async () => {
    const { calls } = installFetch(routes({ [`POST ${V1}/contacts/filter`]: { json: { meta: { count: 0, current_page: 1 }, payload: [] } } }));
    await setup().call("chatwoot_filter_contacts", {
      conditions: [{ attribute_key: "country_code", filter_operator: "equal_to", values: ["JP"] }],
    });
    expect(calls[0]!.query.get("page")).toBe("1");
    expect(calls[0]!.body).toEqual({ payload: [{ attribute_key: "country_code", filter_operator: "equal_to", values: ["JP"] }] });
  });
});

describe("chatwoot_get_contact", () => {
  it("GET /contacts/{id} の payload を詳細にし、追加属性の秘匿情報を伏せる", async () => {
    const { calls } = installFetch(
      routes({ [`GET ${V1}/contacts/12`]: { json: { payload: contact({ additional_attributes: { company_name: "Example", session_token: "t" } }) } } }),
    );
    const result = await setup().call("chatwoot_get_contact", { contact_id: 12, response_format: "json" });
    expect(calls).toHaveLength(1);
    expect((result.structuredContent as any).contact).toMatchObject({ id: 12, additional_attributes: { company_name: "Example", session_token: "[redacted]" } });
  });

  it("404 はコンタクトの探し方を案内する", async () => {
    installFetch(() => ({ status: 404, json: { error: "not found" } }));
    const result = await setup().call("chatwoot_get_contact", { contact_id: 99 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(CONTACT_NOT_FOUND);
  });
});
