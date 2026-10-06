import { describe, expect, it } from "vitest";

import { MauticApiError } from "../../src/services/mautic-client.js";
import { registerRelatedTools } from "../../src/tools/related.js";
import { createFakeClient, createFakeServer } from "../helpers/fake-server.js";

function setup() {
  const fake = createFakeServer();
  const client = createFakeClient();
  registerRelatedTools(fake.server, client.client);
  return { ...fake, ...client };
}

describe("registerRelatedTools", () => {
  it("2 ツールを参照専用で登録する", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual(["mautic_list_campaign_contacts", "mautic_list_form_submissions"]);
    for (const tool of tools.values()) expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("mautic_list_campaign_contacts", () => {
  it("/campaigns/{id}/contacts をページングして呼び、ページング付きの JSON を返す", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 3, items: [{ lead_id: "5" }, { lead_id: "6" }], meta: {} });
    const result = await call("mautic_list_campaign_contacts", { campaign_id: 2, limit: 2, offset: 0 });

    expect(getList).toHaveBeenCalledWith("/campaigns/2/contacts", "contacts", { start: 0, limit: 2 });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      total: 3,
      count: 2,
      offset: 0,
      has_more: true,
      next_offset: 2,
      items: [{ lead_id: "5" }, { lead_id: "6" }],
    });
  });

  it("API エラーは isError の結果にする", async () => {
    const { call, getList } = setup();
    getList.mockRejectedValue(new MauticApiError(404, "Campaign not found"));
    expect((await call("mautic_list_campaign_contacts", { campaign_id: 99 })).isError).toBe(true);
  });
});

describe("mautic_list_form_submissions", () => {
  it("contact_id がなければフォーム全体の送信を取る", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 0, items: [], meta: {} });
    await call("mautic_list_form_submissions", { form_id: 4 });
    expect(getList).toHaveBeenCalledWith("/forms/4/submissions", "submissions", { start: 0, limit: 20 });
  });

  it("contact_id があればそのコンタクトの送信だけを取る", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 0, items: [], meta: {} });
    await call("mautic_list_form_submissions", { form_id: 4, contact_id: 42, offset: 20 });
    expect(getList).toHaveBeenCalledWith("/forms/4/submissions/contact/42", "submissions", { start: 20, limit: 20 });
  });

  it("送信内容の秘匿情報らしい項目を伏せる", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 1, items: [{ id: 1, results: { email: "a@example.com", password: "hunter2" } }], meta: {} });
    const result = await call("mautic_list_form_submissions", { form_id: 4 });
    expect(result.content[0]!.text).not.toContain("hunter2");
    expect(JSON.parse(result.content[0]!.text).items[0].results).toEqual({ email: "a@example.com", password: "[redacted]" });
  });
});
