import { describe, expect, it } from "vitest";

import { GETTABLE, LISTABLE } from "../../src/resources.js";
import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { registerRecordTools } from "../../src/tools/records.js";
import { installFetch, installFetchFailure, networkError, routes, V1 } from "../helpers/fetch.js";
import { createFakeServer, makeCtx, textOf } from "../helpers/server.js";

function setup() {
  const fake = createFakeServer();
  registerRecordTools(fake.server, makeCtx());
  return fake;
}

describe("registerRecordTools", () => {
  describe("正常系", () => {
    it("一覧・取得の 2 ツールを参照専用の注釈で登録する", () => {
      const fake = setup();
      expect(fake.names()).toEqual(["chatwoot_list_records", "chatwoot_get_record"]);
      for (const { config } of fake.tools.values()) expect(config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    });

    it("resource の選択肢は一覧・取得できるリソースに限る", () => {
      const fake = setup();
      expect(fake.tools.get("chatwoot_list_records")!.config.inputSchema.shape.resource.options).toEqual(LISTABLE);
      expect(fake.tools.get("chatwoot_get_record")!.config.inputSchema.shape.resource.options).toEqual(GETTABLE);
    });
  });

  describe("異常系", () => {
    it("入力: 一覧できないリソース（integration_hooks）は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_records", { resource: "integration_hooks" })).rejects.toThrow();
    });
  });
});

describe("chatwoot_list_records", () => {
  describe("正常系", () => {
    it("リソースのパスを GET し、custom_attribute_definitions には attribute_model を渡す", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/custom_attribute_definitions`]: { json: [] } }));
      await setup().call("chatwoot_list_records", { resource: "custom_attribute_definitions", attribute_model: "contact_attribute" });
      expect(calls[0]!.query.get("attribute_model")).toBe("contact_attribute");
    });

    it("応答の形（payload / payload.webhooks）に合わせて取り出し、要約項目と名前だけを返す", async () => {
      installFetch(
        routes({
          [`GET ${V1}/inboxes`]: { json: { payload: [{ id: 1, name: "Web", channel_type: "Channel::WebWidget", hmac_token: "h", website_token: "w" }] } },
          [`GET ${V1}/webhooks`]: { json: { payload: { webhooks: [{ id: 2, name: "CRM", url: "https://x", secret: "s", subscriptions: ["message_created"] }] } } },
        }),
      );
      const fake = setup();
      expect((await fake.call("chatwoot_list_records", { resource: "inboxes" })).structuredContent).toMatchObject({
        resource: "inboxes",
        items: [{ id: 1, name: "Web", channel_type: "Channel::WebWidget" }],
      });
      const webhooks = (await fake.call("chatwoot_list_records", { resource: "webhooks", response_format: "json" })).structuredContent as any;
      expect(webhooks.items).toEqual([{ id: 2, name: "CRM", url: "https://x", subscriptions: ["message_created"] }]);
    });

    it("ページングのない一覧を 50 件ずつに区切る", async () => {
      const labels = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, title: `label-${i + 1}` }));
      installFetch(routes({ [`GET ${V1}/labels`]: { json: { payload: labels } } }));
      const fake = setup();
      const first = (await fake.call("chatwoot_list_records", { resource: "labels" })).structuredContent as any;
      expect(first).toMatchObject({ page: 1, count: 50, total: 120, has_more: true, next_page: 2 });
      const last = (await fake.call("chatwoot_list_records", { resource: "labels", page: 3 })).structuredContent as any;
      expect(last).toMatchObject({ page: 3, count: 20, has_more: false });
      expect(last.items[0]).toEqual({ id: 101, name: "label-101" });
    });

    it("一覧では長い値を 300 文字で省略する", async () => {
      installFetch(routes({ [`GET ${V1}/canned_responses`]: { json: [{ id: 1, short_code: "long", content: "c".repeat(301) }] } }));
      const result = await setup().call("chatwoot_list_records", { resource: "canned_responses" });
      expect((result.structuredContent as any).items[0].content).toContain("[omitted 301 chars");
    });

    it("空入力: 0 件のときは「No records found.」を返す", async () => {
      installFetch(routes({ [`GET ${V1}/teams`]: { json: [] } }));
      expect(textOf(await setup().call("chatwoot_list_records", { resource: "teams" }))).toBe("# teams\n\nNo records found.");
    });

    it("空入力: 件数を超えたページを指定すると 0 件で返す（続きなし）", async () => {
      installFetch(routes({ [`GET ${V1}/teams`]: { json: [{ id: 1, name: "a" }] } }));
      expect((await setup().call("chatwoot_list_records", { resource: "teams", page: 5 })).structuredContent).toMatchObject({ count: 0, total: 1, has_more: false });
    });
  });

  describe("異常系", () => {
    it("空入力: resource がないと入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_records", {})).rejects.toThrow();
    });

    it("入力: 空白だけの search・未知の attribute_model は入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_list_records", { resource: "canned_responses", search: "  " })).rejects.toThrow();
      await expect(setup().call("chatwoot_list_records", { resource: "custom_attribute_definitions", attribute_model: "x" })).rejects.toThrow();
    });

    it("サーバ: 想定外の形の応答（一覧のはずがオブジェクト）は 0 件として返す", async () => {
      installFetch(routes({ [`GET ${V1}/teams`]: { json: { error: "unexpected" } } }));
      const result = await setup().call("chatwoot_list_records", { resource: "teams" });
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toBe("# teams\n\nNo records found.");
    });

    it("サーバ: 401（管理者でない）は権限不足として返す", async () => {
      installFetch(() => ({ status: 401, json: { error: "You are not authorized to do this action" } }));
      const result = await setup().call("chatwoot_list_records", { resource: "webhooks" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Permission denied");
    });

    it("サーバ: 通信失敗は isError で返す", async () => {
      installFetchFailure(networkError());
      expect(textOf(await setup().call("chatwoot_list_records", { resource: "labels" }))).toContain("Could not reach Chatwoot");
    });
  });
});

describe("chatwoot_get_record", () => {
  describe("正常系", () => {
    it("取得 API があるリソースは GET {path}/{id} を呼ぶ", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/labels/3`]: { json: { id: 3, title: "billing" } } }));
      const result = await setup().call("chatwoot_get_record", { resource: "labels", id: 3, response_format: "json" });
      expect(calls).toHaveLength(1);
      expect(result.structuredContent).toEqual({ resource: "labels", record: { id: 3, title: "billing" } });
    });

    it("payload で返すリソース（automation_rules）は中身を取り出す", async () => {
      installFetch(routes({ [`GET ${V1}/automation_rules/2`]: { json: { payload: { id: 2, name: "Tag" } } } }));
      expect((await setup().call("chatwoot_get_record", { resource: "automation_rules", id: 2 })).structuredContent).toEqual({
        resource: "automation_rules",
        record: { id: 2, name: "Tag" },
      });
    });

    it("取得 API がないリソース（agents）は一覧から ID で探す", async () => {
      const { calls } = installFetch(routes({ [`GET ${V1}/agents`]: { json: [{ id: 4, name: "A" }, { id: 5, name: "B", access_token: "t" }] } }));
      const result = await setup().call("chatwoot_get_record", { resource: "agents", id: 5 });
      expect(calls.map((call) => call.path)).toEqual([`${V1}/agents`]);
      expect((result.structuredContent as any).record).toEqual({ id: 5, name: "B", access_token: "[redacted]" });
    });

    it("ポータルは slug で一覧から探す", async () => {
      installFetch(routes({ [`GET ${V1}/portals`]: { json: { payload: [{ id: 1, slug: "help", name: "Help" }] } } }));
      expect((await setup().call("chatwoot_get_record", { resource: "portals", id: "help" })).structuredContent).toMatchObject({
        record: { slug: "help", name: "Help" },
      });
    });

    it("Webhook は一覧から探し、secret を伏せて返す", async () => {
      installFetch(routes({ [`GET ${V1}/webhooks`]: { json: { payload: { webhooks: [{ id: 2, url: "https://x", secret: "whsec-123" }] } } } }));
      const result = await setup().call("chatwoot_get_record", { resource: "webhooks", id: 2 });
      expect(textOf(result)).not.toContain("whsec-123");
    });

    it("文字列の ID はパスに入れる前にエンコードする", async () => {
      const { calls } = installFetch(() => ({ json: { id: 1 } }));
      await setup().call("chatwoot_get_record", { resource: "labels", id: "a/b" });
      expect(calls[0]!.url.pathname).toBe(`${V1}/labels/a%2Fb`);
    });
  });

  describe("異常系", () => {
    it("空入力: 一覧が 0 件なら 404 として扱い、一覧ツールを案内する", async () => {
      installFetch(routes({ [`GET ${V1}/agents`]: { json: [] } }));
      const result = await setup().call("chatwoot_get_record", { resource: "agents", id: 4 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("agents 4 does not exist");
    });

    it("空入力: 空白だけの ID は入力検証で拒否し、API を呼ばない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await expect(setup().call("chatwoot_get_record", { resource: "labels", id: "   " })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("入力: 0 以下の数値 ID・取得できないリソースは入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_get_record", { resource: "labels", id: 0 })).rejects.toThrow();
      await expect(setup().call("chatwoot_get_record", { resource: "integration_hooks", id: 1 })).rejects.toThrow();
    });

    it("サーバ: 一覧に見つからなければ 404 として扱い、一覧ツールを案内する", async () => {
      installFetch(routes({ [`GET ${V1}/agents`]: { json: [{ id: 4 }] } }));
      const result = await setup().call("chatwoot_get_record", { resource: "agents", id: 99 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Error: Not found (agents 99 does not exist). Find valid IDs with chatwoot_list_records resource="agents".');
    });

    it("サーバ: 取得 API の 404 も一覧ツールを案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "Resource could not be found" } }));
      expect(textOf(await setup().call("chatwoot_get_record", { resource: "labels", id: 3 }))).toContain('chatwoot_list_records resource="labels"');
    });

    it("サーバ: JSON でない応答（プロキシのエラーページ）は isError で返す", async () => {
      installFetch(() => ({ text: "<html>502</html>" }));
      const result = await setup().call("chatwoot_get_record", { resource: "labels", id: 3 });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("non-JSON response");
    });
  });
});
