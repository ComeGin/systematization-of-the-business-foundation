import { describe, expect, it } from "vitest";

import { CREATABLE, DELETABLE, UPDATABLE } from "../../src/resources.js";
import { CREATE_ANNOTATIONS, DESTRUCTIVE_ANNOTATIONS } from "../../src/tools/annotations.js";
import { registerRecordWriteTools } from "../../src/tools/write-records.js";
import { callKeys, installFetch, routes, V1 } from "../helpers/fetch.js";
import { createFakeServer, jsonOf, makeCtx, textOf } from "../helpers/server.js";

type Level = "read_only" | "read_write" | "full";

function setup(level: Level = "full") {
  const fake = createFakeServer();
  registerRecordWriteTools(fake.server, makeCtx(), level);
  return fake;
}

describe("registerRecordWriteTools", () => {
  it("read_only では何も登録しない", () => {
    expect(setup("read_only").names()).toEqual([]);
  });

  it("read_write では削除以外の 5 ツールを登録する", () => {
    expect(setup("read_write").names()).toEqual([
      "chatwoot_create_record",
      "chatwoot_update_record",
      "chatwoot_update_account",
      "chatwoot_set_members",
      "chatwoot_set_inbox_agent_bot",
    ]);
  });

  it("full では chatwoot_delete_record も登録する", () => {
    expect(setup("full").names()).toContain("chatwoot_delete_record");
    expect(setup("full").names()).toHaveLength(6);
  });

  it("作成は CREATE、それ以外は destructiveHint 付きの注釈にする", () => {
    const { tools } = setup();
    expect(tools.get("chatwoot_create_record")!.config.annotations).toEqual(CREATE_ANNOTATIONS);
    for (const name of ["chatwoot_update_record", "chatwoot_update_account", "chatwoot_set_members", "chatwoot_set_inbox_agent_bot", "chatwoot_delete_record"]) {
      expect(tools.get(name)!.config.annotations, name).toEqual(DESTRUCTIVE_ANNOTATIONS);
    }
  });

  it("resource の選択肢は作成・更新・削除できるリソースにそれぞれ限る", async () => {
    const { tools, call } = setup();
    expect(tools.get("chatwoot_create_record")!.config.inputSchema.shape.resource.options).toEqual(CREATABLE);
    expect(tools.get("chatwoot_update_record")!.config.inputSchema.shape.resource.options).toEqual(UPDATABLE);
    expect(tools.get("chatwoot_delete_record")!.config.inputSchema.shape.resource.options).toEqual(DELETABLE);
    await expect(call("chatwoot_delete_record", { resource: "inboxes", id: 1 })).rejects.toThrow();
    await expect(call("chatwoot_update_record", { resource: "portal_categories", id: 1, data: { name: "x" } })).rejects.toThrow();
  });
});

describe("chatwoot_create_record", () => {
  it("コントローラが要求するキーで本文を包んで POST する（labels → label）", async () => {
    const { calls } = installFetch(routes({ [`POST ${V1}/labels`]: { json: { id: 3, title: "billing" } } }));
    const result = await setup().call("chatwoot_create_record", { resource: "labels", data: { title: "billing" }, response_format: "json" });
    expect(calls[0]!.body).toEqual({ label: { title: "billing" } });
    expect(result.structuredContent).toEqual({ action: "created", resource: "labels", record: { id: 3, title: "billing" } });
  });

  it("包むキーのないリソース（inboxes）はそのまま送る", async () => {
    const { calls } = installFetch(routes({ [`POST ${V1}/inboxes`]: { json: { id: 1 } } }));
    await setup().call("chatwoot_create_record", { resource: "inboxes", data: { name: "API", channel: { type: "api" } } });
    expect(calls[0]!.body).toEqual({ name: "API", channel: { type: "api" } });
  });

  it("ポータル配下のリソースは parent_id（slug）のパスに作る", async () => {
    const { calls } = installFetch(routes({ [`POST ${V1}/portals/my%20help/categories`]: { json: { payload: { id: 9, name: "Billing" } } } }));
    const result = await setup().call("chatwoot_create_record", { resource: "portal_categories", parent_id: "my help", data: { name: "Billing" } });
    expect(calls[0]!.body).toEqual({ category: { name: "Billing" } });
    expect(result.structuredContent).toMatchObject({ record: { id: 9, name: "Billing" } });
  });

  it("parent_id が必要なリソースで省略すると API を呼ばずに拒否する", async () => {
    const { calls } = installFetch(() => ({ json: {} }));
    const result = await setup().call("chatwoot_create_record", { resource: "portal_articles", data: { title: "x" } });
    expect(calls).toHaveLength(0);
    expect(textOf(result)).toContain("portal_articles requires parent_id (Portal slug)");
  });

  it("作成結果の秘匿情報（Webhook の secret など）を伏せる", async () => {
    installFetch(routes({ [`POST ${V1}/webhooks`]: { json: { payload: { webhook: { id: 1, url: "https://x", secret: "whsec" } } } } }));
    const result = await setup().call("chatwoot_create_record", { resource: "webhooks", data: { url: "https://x" }, response_format: "json" });
    expect(textOf(result)).not.toContain("whsec");
  });

  it("data が空なら入力検証で拒否する", async () => {
    await expect(setup().call("chatwoot_create_record", { resource: "labels", data: {} })).rejects.toThrow();
  });
});

describe("chatwoot_update_record", () => {
  it("PATCH {path}/{id} で部分更新する（PUT は使わない）", async () => {
    const { calls } = installFetch(routes({ [`PATCH ${V1}/labels/3`]: { json: { id: 3, color: "#FF0000" } } }));
    const result = await setup().call("chatwoot_update_record", { resource: "labels", id: 3, data: { color: "#FF0000" } });
    expect(callKeys(calls)).toEqual([`PATCH ${V1}/labels/3`]);
    expect(calls[0]!.body).toEqual({ label: { color: "#FF0000" } });
    expect(result.structuredContent).toMatchObject({ action: "updated", resource: "labels" });
  });

  it("ポータルは slug をエンコードしてパスに入れる", async () => {
    const { calls } = installFetch(() => ({ json: { slug: "my help" } }));
    await setup().call("chatwoot_update_record", { resource: "portals", id: "my help", data: { name: "Help" } });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe(`${V1}/portals/my%20help`);
    expect(calls[0]!.body).toEqual({ portal: { name: "Help" } });
  });

  it("秘匿情報を伏せて返す", async () => {
    installFetch(() => ({ json: { payload: { id: 1, name: "bot", access_token: "bot-token" } } }));
    const result = await setup().call("chatwoot_update_record", { resource: "agent_bots", id: 1, data: { name: "bot" } });
    expect((result.structuredContent as any).record.access_token).toBe("[redacted]");
    expect(textOf(result)).not.toContain("bot-token");
  });

  it("404 は一覧ツールを案内する", async () => {
    installFetch(() => ({ status: 404, json: { error: "x" } }));
    expect(textOf(await setup().call("chatwoot_update_record", { resource: "teams", id: 9, data: { name: "x" } }))).toContain(
      'Find valid IDs with chatwoot_list_records resource="teams".',
    );
  });
});

describe("chatwoot_update_account", () => {
  it("アカウント自体（/api/v1/accounts/{id}）を PATCH し、本文は包まない", async () => {
    const { calls } = installFetch(routes({ [`PATCH ${V1}`]: { json: { id: 1, name: "New" } } }));
    const result = await setup().call("chatwoot_update_account", { data: { name: "New", auto_resolve_after: null } });
    expect(calls[0]!.body).toEqual({ name: "New", auto_resolve_after: null });
    expect(jsonOf(result)).toEqual({ updated: "account", account: { id: 1, name: "New" } });
  });
});

describe("chatwoot_set_members", () => {
  it.each([
    ["add", "POST"],
    ["remove", "DELETE"],
    ["replace", "PATCH"],
  ])("受信箱の %s は %s /inbox_members を呼び、メンバー一覧を読み直す", async (mode, method) => {
    const { calls } = installFetch(
      routes({
        [`${method} ${V1}/inbox_members`]: { json: {} },
        [`GET ${V1}/inbox_members/2`]: { json: { payload: [{ id: 5, available_name: "Hanako", email: "h@example.com", role: "agent", access_token: "t" }] } },
      }),
    );
    const result = await setup().call("chatwoot_set_members", { target: "inbox", id: 2, user_ids: [5], mode });
    expect(callKeys(calls)).toEqual([`${method} ${V1}/inbox_members`, `GET ${V1}/inbox_members/2`]);
    expect(calls[0]!.body).toEqual({ inbox_id: 2, user_ids: [5] });
    expect(jsonOf(result).members).toEqual([{ id: 5, name: "Hanako", email: "h@example.com", role: "agent" }]);
  });

  it("チームは /teams/{id}/team_members に user_ids だけを送る", async () => {
    const { calls } = installFetch(routes({ [`PATCH ${V1}/teams/1/team_members`]: { json: [] }, [`GET ${V1}/teams/1/team_members`]: { json: [] } }));
    await setup().call("chatwoot_set_members", { target: "team", id: 1, user_ids: [3, 4], mode: "replace" });
    expect(calls[0]!.body).toEqual({ user_ids: [3, 4] });
  });
});

describe("chatwoot_set_inbox_agent_bot", () => {
  it("POST /inboxes/{id}/set_agent_bot でつなぎ、接続中のボットを読み直す", async () => {
    const { calls } = installFetch(
      routes({
        [`POST ${V1}/inboxes/3/set_agent_bot`]: { text: "" },
        [`GET ${V1}/inboxes/3/agent_bot`]: { json: { agent_bot: { id: 5, name: "FAQ", access_token: "t" } } },
      }),
    );
    const result = await setup().call("chatwoot_set_inbox_agent_bot", { inbox_id: 3, agent_bot_id: 5 });
    expect(calls[0]!.body).toEqual({ agent_bot: 5 });
    expect(jsonOf(result)).toEqual({ inbox_id: 3, agent_bot: { id: 5, name: "FAQ" } });
  });

  it("agent_bot_id=null で切り離し、空のボットは null として返す", async () => {
    const { calls } = installFetch(
      routes({ [`POST ${V1}/inboxes/3/set_agent_bot`]: { text: "" }, [`GET ${V1}/inboxes/3/agent_bot`]: { json: { agent_bot: {} } } }),
    );
    const result = await setup().call("chatwoot_set_inbox_agent_bot", { inbox_id: 3, agent_bot_id: null });
    expect(calls[0]!.body).toEqual({ agent_bot: null });
    expect(jsonOf(result)).toEqual({ inbox_id: 3, agent_bot: null });
  });
});

describe("chatwoot_delete_record", () => {
  it("DELETE {path}/{id} を呼ぶ", async () => {
    const { calls } = installFetch(() => ({ text: "" }));
    const result = await setup().call("chatwoot_delete_record", { resource: "custom_attribute_definitions", id: 4 });
    expect(callKeys(calls)).toEqual([`DELETE ${V1}/custom_attribute_definitions/4`]);
    expect(jsonOf(result)).toEqual({ deleted: "custom_attribute_definitions", id: 4 });
  });
});
