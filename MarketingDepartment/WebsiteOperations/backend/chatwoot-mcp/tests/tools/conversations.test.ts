import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT } from "../../src/constants.js";
import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { CONVERSATION_NOT_FOUND, registerConversationTools } from "../../src/tools/conversations.js";
import { installFetch, installFetchFailure, networkError, routes, timeoutError, V1 } from "../helpers/fetch.js";
import { ACCESS_TOKEN, conversation, createFakeServer, makeCtx, message, textOf } from "../helpers/server.js";

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
  describe("正常系", () => {
    it("参照系 4 ツールを参照専用の注釈で登録する", () => {
      const fake = setup();
      expect(fake.names()).toEqual(["chatwoot_list_conversations", "chatwoot_filter_conversations", "chatwoot_get_conversation", "chatwoot_list_messages"]);
      for (const { config } of fake.tools.values()) expect(config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    });
  });
});

describe("chatwoot_list_conversations", () => {
  describe("正常系", () => {
    it("空入力: 引数なしなら既定値（open・all・last_activity_at_desc・page 1）で GET /conversations を呼ぶ", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/conversations`]: listResponse([]) }));
      await setup().call("chatwoot_list_conversations");
      expect(calls).toHaveLength(1);
      expect(Object.fromEntries(calls[0]!.query)).toEqual({ status: "open", assignee_type: "all", sort_by: "last_activity_at_desc", page: "1" });
    });

    it("空入力: 0 件なら件数の内訳付きで「No conversations found」を返す", async () => {
      installFetch(routes({ [`GET ${V1}/conversations`]: listResponse([], { mine_count: 0, assigned_count: 0, unassigned_count: 0, all_count: 0 }) }));
      const result = await setup().call("chatwoot_list_conversations");
      expect(textOf(result)).toContain("No conversations found (mine: 0, assigned: 0, unassigned: 0, all: 0).");
      expect(result.structuredContent).toMatchObject({ count: 0, total: 0, has_more: false, items: [] });
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
  });

  describe("異常系", () => {
    it("入力: 応答が上限を超えると件数を減らし、truncation_message を付ける", async () => {
      // custom_attributes も sanitize で LONG_TEXT_LIMIT（1,000 文字）を超える値が省略されるため、1,000 文字未満の値を 3 つ持たせて上限を超えさせる
      const note = "n".repeat(900);
      const payload = Array.from({ length: 25 }, (_, i) => conversation({ id: i + 1, custom_attributes: { note_a: note, note_b: note, note_c: note } }));
      installFetch(routes({ [`GET ${V1}/conversations`]: listResponse(payload) }));
      const result = await setup().call("chatwoot_list_conversations", { response_format: "json" });
      const structured = result.structuredContent as any;
      expect(structured.count).toBeLessThan(25);
      expect(structured.items).toHaveLength(structured.count);
      expect(structured.truncation_message).toContain("Narrow the filters to see the rest.");
      expect(textOf(result).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    });

    it("入力: 未知の status・0 以下の inbox_id・空白だけの q は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_conversations", { status: "closed" })).rejects.toThrow();
      await expect(setup().call("chatwoot_list_conversations", { inbox_id: 0 })).rejects.toThrow();
      await expect(setup().call("chatwoot_list_conversations", { q: "  " })).rejects.toThrow();
    });

    it("サーバ: 上流のエラーは isError で返す", async () => {
      installFetch(() => ({ status: 500, json: {} }));
      const result = await setup().call("chatwoot_list_conversations");
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Chatwoot server error (500)");
    });

    it("サーバ: 404 は inbox_id / team_id の確認を案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      expect(textOf(await setup().call("chatwoot_list_conversations", { inbox_id: 99 }))).toContain("Check that inbox_id / team_id exist");
    });

    it("サーバ: 401（トークン不正）・通信失敗・タイムアウトは isError で返し、トークンを含めない", async () => {
      installFetch(() => ({ status: 401, json: { error: "Invalid Access Token" } }));
      const unauthorized = textOf(await setup().call("chatwoot_list_conversations"));
      expect(unauthorized).toContain("rejected the access token");
      expect(unauthorized).not.toContain(ACCESS_TOKEN);
      installFetchFailure(networkError());
      expect(textOf(await setup().call("chatwoot_list_conversations"))).toContain("Could not reach Chatwoot");
      installFetchFailure(timeoutError());
      expect(textOf(await setup().call("chatwoot_list_conversations"))).toContain("did not respond within");
    });

    it("サーバ: 想定外の形の応答（data なし）は例外にせず isError で返す", async () => {
      installFetch(routes({ [`GET ${V1}/conversations`]: { json: { payload: [] } } }));
      expect((await setup().call("chatwoot_list_conversations")).isError).toBe(true);
    });
  });
});

describe("chatwoot_filter_conversations", () => {
  describe("正常系", () => {
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

    it("空入力: meta に all_count がない 0 件の応答は total=0 として返す", async () => {
      installFetch(routes({ [`POST ${V1}/conversations/filter`]: { json: { meta: {}, payload: [] } } }));
      const result = await setup().call("chatwoot_filter_conversations", { conditions: [{ attribute_key: "labels", filter_operator: "is_present" }] });
      expect(result.structuredContent).toMatchObject({ count: 0, total: 0, has_more: false });
    });
  });

  describe("異常系", () => {
    it("空入力: 条件が空なら入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_filter_conversations", { conditions: [] })).rejects.toThrow();
    });

    it("入力: 未知の演算子は入力検証で拒否し、API を呼ばない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await expect(setup().call("chatwoot_filter_conversations", { conditions: [{ attribute_key: "status", filter_operator: "like" }] })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("サーバ: 422（演算子と属性の組み合わせ不正など）は拒否理由を返す", async () => {
      installFetch(() => ({ status: 422, json: { error: "Invalid operator" } }));
      const result = await setup().call("chatwoot_filter_conversations", { conditions: [{ attribute_key: "status", filter_operator: "contains", values: ["o"] }] });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("rejected the request (Invalid operator)");
    });
  });
});

describe("chatwoot_get_conversation", () => {
  describe("正常系", () => {
    it("表示番号のパス /conversations/{#番号} を GET する", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/conversations/42`]: { json: conversation() } }));
      const result = await setup().call("chatwoot_get_conversation", { conversation_id: 42, response_format: "json" });
      expect(calls).toHaveLength(1);
      expect((result.structuredContent as any).conversation.id).toBe(42);
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    });

    it("空入力: 連絡先・属性が空の会話でも Markdown を組み立てる", async () => {
      installFetch(routes({ [`GET ${V1}/conversations/42`]: { json: conversation({ meta: {} }) } }));
      const text = textOf(await setup().call("chatwoot_get_conversation", { conversation_id: 42 }));
      expect(text).toContain("# Conversation #42");
      expect(text).not.toContain("## Contact");
    });
  });

  describe("異常系", () => {
    it("空入力: conversation_id がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_get_conversation", {})).rejects.toThrow();
    });

    it("入力: conversation_id が 0・小数なら入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_get_conversation", { conversation_id: 0 })).rejects.toThrow();
      await expect(setup().call("chatwoot_get_conversation", { conversation_id: 4.2 })).rejects.toThrow();
    });

    it("サーバ: 404 は「UI の #番号を使う」案内を付ける", async () => {
      installFetch(() => ({ status: 404, json: { error: "not found" } }));
      const result = await setup().call("chatwoot_get_conversation", { conversation_id: 999 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(CONVERSATION_NOT_FOUND);
    });

    it("サーバ: 403（API 無効）は isError で返す", async () => {
      installFetch(() => ({ status: 403, json: { error: "API access disabled" } }));
      expect(textOf(await setup().call("chatwoot_get_conversation", { conversation_id: 42 }))).toContain("Forbidden (API access disabled)");
    });
  });
});

describe("chatwoot_list_messages", () => {
  const meta = { labels: ["vip"], contact: { id: 12, name: "山田", email: "a@example.com" }, assignee: { id: 5, available_name: "Hanako" } };

  describe("正常系", () => {
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

    it("空入力: メッセージが 0 件・meta が空なら「No messages in this range.」を返し、連絡先・担当者は null にする", async () => {
      installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta: {}, payload: [] } } }));
      const result = await setup().call("chatwoot_list_messages", { conversation_id: 42 });
      expect(textOf(result)).toContain("No messages in this range.");
      expect(result.structuredContent).toMatchObject({ count: 0, conversation: { contact: null, assignee: null }, messages: [] });
    });
  });

  describe("異常系", () => {
    it("入力: 長い本文は include_long_text=true のときだけ全文を返す", async () => {
      const long = "L".repeat(1_500);
      installFetch(routes({ [`GET ${V1}/conversations/42/messages`]: { json: { meta, payload: [message({ content: long })] } } }));
      const fake = setup();
      expect((await fake.call("chatwoot_list_messages", { conversation_id: 42 })).structuredContent).not.toMatchObject({ messages: [{ content: long }] });
      expect((await fake.call("chatwoot_list_messages", { conversation_id: 42, include_long_text: true })).structuredContent).toMatchObject({
        messages: [{ content: long }],
      });
    });

    it("入力: before=0・after=-1 は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_messages", { conversation_id: 42, before: 0 })).rejects.toThrow();
      await expect(setup().call("chatwoot_list_messages", { conversation_id: 42, after: -1 })).rejects.toThrow();
    });

    it("空入力: conversation_id がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_messages", {})).rejects.toThrow();
    });

    it("サーバ: 404 は「UI の #番号を使う」案内を付ける", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      const result = await setup().call("chatwoot_list_messages", { conversation_id: 7 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(CONVERSATION_NOT_FOUND);
    });

    it("サーバ: JSON でない応答は isError で返す", async () => {
      installFetch(() => ({ text: "<html>Rack::Timeout</html>" }));
      expect(textOf(await setup().call("chatwoot_list_messages", { conversation_id: 42 }))).toContain("non-JSON response");
    });
  });
});
