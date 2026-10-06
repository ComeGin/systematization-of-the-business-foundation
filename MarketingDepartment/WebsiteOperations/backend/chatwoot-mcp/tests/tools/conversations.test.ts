import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT } from "../../src/constants.js";
import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { CONVERSATION_NOT_FOUND, registerConversationTools } from "../../src/tools/conversations.js";
import { installFetch, routes, V1 } from "../helpers/fetch.js";
import { conversation, createFakeServer, makeCtx, message, textOf } from "../helpers/server.js";

function setup() {
  const fake = createFakeServer();
  registerConversationTools(fake.server, makeCtx());
  return fake;
}

const COUNTS = { mine_count: 1, assigned_count: 30, unassigned_count: 5, all_count: 35 };

function listResponse(payload: unknown[], meta = COUNTS) {
  return { json: { data: { meta, payload } } };
}

describe("registerConversationTools", () => {
  it("参照系 4 ツールを参照専用の注釈で登録する", () => {
    const fake = setup();
    expect(fake.names()).toEqual(["chatwoot_list_conversations", "chatwoot_filter_conversations", "chatwoot_get_conversation", "chatwoot_list_messages"]);
    for (const { config } of fake.tools.values()) expect(config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
  });
});

describe("chatwoot_list_conversations", () => {
  it("既定値（open・all・last_activity_at_desc・page 1）で GET /conversations を呼ぶ", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}/conversations`]: listResponse([]) }));
    await setup().call("chatwoot_list_conversations");
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.query)).toEqual({ status: "open", assignee_type: "all", sort_by: "last_activity_at_desc", page: "1" });
  });

  it("ラベル・受信箱・本文検索をクエリに載せる", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}/conversations`]: listResponse([]) }));
    await setup().call("chatwoot_list_conversations", { labels: ["billing", "vip"], inbox_id: 3, q: "invoice" });
    expect(calls[0]!.query.getAll("labels[]")).toEqual(["billing", "vip"]);
    expect(calls[0]!.query.get("inbox_id")).toBe("3");
    expect(calls[0]!.query.get("q")).toBe("invoice");
  });

  it("総件数は assignee_type に対応する件数を使い、続きの有無を固定ページ件数（25）から決める", async () => {
    installFetch(routes({ [`GET ${V1}/conversations`]: listResponse([conversation()]) }));
    const fake = setup();
    const assigned = (await fake.call("chatwoot_list_conversations", { assignee_type: "assigned", response_format: "json" })).structuredContent as any;
    expect(assigned).toMatchObject({ total: 30, has_more: true, next_page: 2, counts: COUNTS });
    const unassigned = (await fake.call("chatwoot_list_conversations", { assignee_type: "unassigned" })).structuredContent as any;
    expect(unassigned).toMatchObject({ total: 5, has_more: false });
    expect(unassigned).not.toHaveProperty("next_page");
  });

  it("項目の id は表示番号（#42）のまま返す", async () => {
    installFetch(routes({ [`GET ${V1}/conversations`]: listResponse([conversation({ id: 42 })]) }));
    const result = await setup().call("chatwoot_list_conversations");
    expect((result.structuredContent as any).items[0].id).toBe(42);
    expect(textOf(result)).toContain("## #42");
  });

  it("応答が上限を超えると件数を減らし、truncation_message を付ける", async () => {
    const payload = Array.from({ length: 25 }, (_, i) => conversation({ id: i + 1, custom_attributes: { note: "n".repeat(2_000) } }));
    installFetch(routes({ [`GET ${V1}/conversations`]: listResponse(payload) }));
    const result = await setup().call("chatwoot_list_conversations", { response_format: "json" });
    const structured = result.structuredContent as any;
    expect(structured.count).toBeLessThan(25);
    expect(structured.items).toHaveLength(structured.count);
    expect(structured.truncation_message).toContain("Narrow the filters to see the rest.");
    expect(textOf(result).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it("上流のエラーは isError で返す", async () => {
    installFetch(() => ({ status: 500, json: {} }));
    const result = await setup().call("chatwoot_list_conversations");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Chatwoot server error (500)");
  });
});

describe("chatwoot_filter_conversations", () => {
  it("POST /conversations/filter に条件を payload で送り、page はクエリで渡す", async () => {
    const { calls } = installFetch(routes({ [`POST ${V1}/conversations/filter`]: { json: { meta: { all_count: 0 }, payload: [] } } }));
    await setup().call("chatwoot_filter_conversations", {
      page: 2,
      conditions: [
        { attribute_key: "status", filter_operator: "equal_to", values: ["open"] },
        { attribute_key: "priority", filter_operator: "equal_to", values: ["urgent"] },
      ],
    });
    expect(calls[0]!.query.get("page")).toBe("2");
    expect(calls[0]!.body).toEqual({
      payload: [
        { attribute_key: "status", filter_operator: "equal_to", values: ["open"], query_operator: "AND" },
        { attribute_key: "priority", filter_operator: "equal_to", values: ["urgent"] },
      ],
    });
  });

  it("総件数は meta.all_count を使う", async () => {
    installFetch(routes({ [`POST ${V1}/conversations/filter`]: { json: { meta: { all_count: 26 }, payload: [conversation()] } } }));
    const result = await setup().call("chatwoot_filter_conversations", { conditions: [{ attribute_key: "labels", filter_operator: "is_present" }] });
    expect(result.structuredContent).toMatchObject({ total: 26, has_more: true });
  });

  it("条件が空なら入力検証で拒否する", async () => {
    await expect(setup().call("chatwoot_filter_conversations", { conditions: [] })).rejects.toThrow();
  });
});

describe("chatwoot_get_conversation", () => {
  it("表示番号のパス /conversations/{#番号} を GET する", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}/conversations/42`]: { json: conversation() } }));
    const result = await setup().call("chatwoot_get_conversation", { conversation_id: 42, response_format: "json" });
    expect(calls).toHaveLength(1);
    expect((result.structuredContent as any).conversation.id).toBe(42);
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("404 は「UI の #番号を使う」案内を付ける", async () => {
    installFetch(() => ({ status: 404, json: { error: "not found" } }));
    const result = await setup().call("chatwoot_get_conversation", { conversation_id: 999 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(CONVERSATION_NOT_FOUND);
  });
});

describe("chatwoot_list_messages", () => {
  const meta = { labels: ["vip"], contact: { id: 12, name: "山田", email: "a@example.com" }, assignee: { id: 5, available_name: "Hanako" } };

  it("GET /conversations/{#番号}/messages に before を渡す", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload: [] } } }));
    await setup().call("chatwoot_list_messages", { conversation_id: 42, before: 500 });
    expect(calls[0]!.query.get("before")).toBe("500");
    expect(calls[0]!.query.has("after")).toBe(false);
  });

  it("20 件そろっていれば最古のメッセージ ID を older_cursor として返す", async () => {
    const payload = Array.from({ length: 20 }, (_, i) => message({ id: 200 + i }));
    installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload } } }));
    const result = await setup().call("chatwoot_list_messages", { conversation_id: 42 });
    expect((result.structuredContent as any).older_cursor).toBe(200);
    expect(textOf(result)).toContain("call again with before=200");
  });

  it("after 指定時や 20 件未満なら older_cursor を返さない", async () => {
    const payload = Array.from({ length: 20 }, (_, i) => message({ id: 200 + i }));
    installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload } } }));
    const fake = setup();
    expect((await fake.call("chatwoot_list_messages", { conversation_id: 42, after: 10 })).structuredContent).not.toHaveProperty("older_cursor");
    installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload: payload.slice(0, 3) } } }));
    expect((await fake.call("chatwoot_list_messages", { conversation_id: 42 })).structuredContent).not.toHaveProperty("older_cursor");
  });

  it("include_activity=false で activity（message_type=2）を除く", async () => {
    const payload = [message({ id: 1 }), message({ id: 2, message_type: 2, content: "Assigned to Hanako" }), message({ id: 3, message_type: 1 })];
    installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload } } }));
    const result = await setup().call("chatwoot_list_messages", { conversation_id: 42, include_activity: false });
    expect((result.structuredContent as any).messages.map((m: any) => m.id)).toEqual([1, 3]);
  });

  it("会話の連絡先・担当者を要約して付ける", async () => {
    installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload: [] } } }));
    const result = await setup().call("chatwoot_list_messages", { conversation_id: 42 });
    expect((result.structuredContent as any).conversation).toEqual({
      labels: ["vip"],
      contact: { id: 12, name: "山田", email: "a@example.com", phone_number: undefined },
      assignee: { id: 5, name: "Hanako" },
    });
  });

  it("長い本文は include_long_text=true のときだけ全文を返す", async () => {
    const long = "L".repeat(1_500);
    installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload: [message({ content: long })] } } }));
    const fake = setup();
    expect((await fake.call("chatwoot_list_messages", { conversation_id: 42 })).structuredContent).not.toMatchObject({ messages: [{ content: long }] });
    expect((await fake.call("chatwoot_list_messages", { conversation_id: 42, include_long_text: true })).structuredContent).toMatchObject({
      messages: [{ content: long }],
    });
  });
});
