import { describe, expect, it } from "vitest";

import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { registerRelatedTools } from "../../src/tools/related.js";
import { installFetch, installFetchFailure, networkError, routes, V1 } from "../helpers/fetch.js";
import { conversation, createFakeServer, jsonOf, makeCtx, textOf } from "../helpers/server.js";

function setup() {
  const fake = createFakeServer();
  registerRelatedTools(fake.server, makeCtx());
  return fake;
}

describe("chatwoot_get_related", () => {
  describe("正常系", () => {
    it("参照専用の注釈で登録する", () => {
      const fake = setup();
      expect(fake.names()).toEqual(["chatwoot_get_related"]);
      expect(fake.tools.get("chatwoot_get_related")!.config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
    });

    it.each([
      ["contact", 12, "labels", `${V1}/contacts/12/labels`],
      ["contact", 12, "contactable_inboxes", `${V1}/contacts/12/contactable_inboxes`],
      ["conversation", 42, "labels", `${V1}/conversations/42/labels`],
      ["conversation", 42, "reporting_events", `${V1}/conversations/42/reporting_events`],
      ["inbox", 3, "members", `${V1}/inbox_members/3`],
      ["inbox", 3, "agent_bot", `${V1}/inboxes/3/agent_bot`],
      ["inbox", 3, "message_templates", `${V1}/inboxes/3/message_templates`],
      ["team", 1, "members", `${V1}/teams/1/team_members`],
    ])("%s %d の %s は GET %s を呼ぶ", async (resource, id, relation, path) => {
      const { calls } = installFetch(() => ({ json: { payload: [] } }));
      await setup().call("chatwoot_get_related", { resource, id, relation });
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET ${path}`]);
    });

    it("payload で包まれた応答は中身を返す", async () => {
      installFetch(routes({ [`GET ${V1}/conversations/42/labels`]: { json: { payload: ["vip", "billing"] } } }));
      const result = await setup().call("chatwoot_get_related", { resource: "conversation", id: 42, relation: "labels" });
      expect(jsonOf(result)).toEqual({ resource: "conversation", id: 42, relation: "labels", data: ["vip", "billing"] });
    });

    it("コンタクトの会話は会話の要約に変換する", async () => {
      installFetch(routes({ [`GET ${V1}/contacts/12/conversations`]: { json: { payload: [conversation({ id: 7, status: "resolved" })] } } }));
      const data = jsonOf(await setup().call("chatwoot_get_related", { resource: "contact", id: 12, relation: "conversations" })).data as any[];
      expect(data[0]).toMatchObject({ id: 7, status: "resolved" });
      expect(data[0]).not.toHaveProperty("uuid");
    });

    it("秘匿情報を伏せる（エージェントボットのアクセストークンなど）", async () => {
      installFetch(routes({ [`GET ${V1}/inboxes/3/agent_bot`]: { json: { agent_bot: { id: 1, name: "FAQ", access_token: "bot-token" } } } }));
      const text = textOf(await setup().call("chatwoot_get_related", { resource: "inbox", id: 3, relation: "agent_bot" }));
      expect(text).not.toContain("bot-token");
      expect(text).toContain("[redacted]");
    });

    it("空入力: 0 件の応答（空の payload）は空配列の data を返す", async () => {
      installFetch(routes({ [`GET ${V1}/contacts/12/conversations`]: { json: { payload: [] } } }));
      const body = jsonOf(await setup().call("chatwoot_get_related", { resource: "contact", id: 12, relation: "conversations" }));
      expect(body.data).toEqual([]);
    });

    it("空入力: ボット未接続（本文なし）は data を null で返す", async () => {
      installFetch(routes({ [`GET ${V1}/inboxes/3/agent_bot`]: { text: "" } }));
      const body = jsonOf(await setup().call("chatwoot_get_related", { resource: "inbox", id: 3, relation: "agent_bot" }));
      expect(body.data).toBeNull();
    });
  });

  describe("異常系", () => {
    it("入力: リソースに存在しない関連を指定すると、API を呼ばずに有効な関連を案内する", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      const result = await setup().call("chatwoot_get_related", { resource: "team", id: 1, relation: "labels" });
      expect(calls).toHaveLength(0);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Error: relation 'labels' is not available for team. Valid relations: members.");
    });

    it("入力: 未知のリソース・0 以下の ID は入力検証で拒否し、API を呼ばない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await expect(setup().call("chatwoot_get_related", { resource: "account", id: 1, relation: "labels" })).rejects.toThrow();
      await expect(setup().call("chatwoot_get_related", { resource: "contact", id: 0, relation: "labels" })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("空入力: 引数なしは入力検証で拒否する", async () => {
      await expect(setup().call("chatwoot_get_related", {})).rejects.toThrow();
    });

    it("サーバ: 404 は親レコードの ID を確かめるよう案内する", async () => {
      installFetch(() => ({ status: 404, json: { error: "x" } }));
      expect(textOf(await setup().call("chatwoot_get_related", { resource: "inbox", id: 3, relation: "members" }))).toContain("Verify the inbox ID first.");
    });

    it("サーバ: 403（API 無効）・通信失敗は isError で返す", async () => {
      installFetch(() => ({ status: 403, json: { error: "forbidden" } }));
      expect(textOf(await setup().call("chatwoot_get_related", { resource: "team", id: 1, relation: "members" }))).toContain("Forbidden");
      installFetchFailure(networkError());
      const result = await setup().call("chatwoot_get_related", { resource: "team", id: 1, relation: "members" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Could not reach Chatwoot");
    });

    it("サーバ: JSON でない応答は isError で返す", async () => {
      installFetch(() => ({ text: "<html>maintenance</html>" }));
      expect(textOf(await setup().call("chatwoot_get_related", { resource: "contact", id: 12, relation: "labels" }))).toContain("non-JSON response");
    });
  });
});
