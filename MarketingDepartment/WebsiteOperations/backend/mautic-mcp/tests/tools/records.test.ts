import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT, LONG_TEXT_LIMIT } from "../../src/constants.js";
import { MauticApiError } from "../../src/services/mautic-client.js";
import { registerRecordTools, renderRecord } from "../../src/tools/records.js";
import { createFakeClient, createFakeServer } from "../helpers/fake-server.js";

function setup() {
  const fake = createFakeServer();
  const client = createFakeClient();
  registerRecordTools(fake.server, client.client);
  return { ...fake, ...client };
}

type Items = Record<string, unknown>[];

describe("registerRecordTools", () => {
  it("一覧・1 件取得の 2 ツールを参照専用で登録する", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual(["mautic_get_record", "mautic_list_records"]);
    for (const tool of tools.values()) expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("mautic_list_records", () => {
  it("resource の path と multi で一覧を取り、order_by がなければ並び順を送らない", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 0, items: [], meta: {} });
    await call("mautic_list_records", { resource: "segments" });
    expect(getList).toHaveBeenCalledWith("/segments", "lists", {
      search: undefined,
      published: undefined,
      start: 0,
      limit: 20,
      orderBy: undefined,
      orderByDir: undefined,
    });
  });

  it("published_only=true なら published=1、order_by があれば方向を大文字で送る", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 0, items: [], meta: {} });
    await call("mautic_list_records", { resource: "pages", published_only: true, order_by: "dateAdded", order_direction: "desc" });
    expect(getList).toHaveBeenCalledWith("/pages", "pages", expect.objectContaining({ published: 1, orderBy: "dateAdded", orderByDir: "DESC" }));
  });

  it("order_by は単一のプロパティ名だけを受け付ける", async () => {
    const { call, getList } = setup();
    await expect(call("mautic_list_records", { resource: "emails", order_by: "name desc, id" })).rejects.toThrow();
    expect(getList).not.toHaveBeenCalled();
  });

  it("共通項目（名前・公開状態・カテゴリ・日時）と resource ごとの項目で要約する", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 3,
          name: "September news",
          subject: "News",
          isPublished: true,
          category: { id: 1, title: "Newsletters" },
          sentCount: 120,
          readCount: 0,
          language: "",
          publishUp: null,
          customHtml: "<p>body</p>",
          dateAdded: "2026-09-01",
        },
      ],
      meta: {},
    });
    const result = await call("mautic_list_records", { resource: "emails" });
    const [item] = result.structuredContent!.items as Items;
    expect(item).toEqual({
      id: 3,
      name: "September news",
      is_published: true,
      category: "Newsletters",
      subject: "News",
      sentCount: 120,
      readCount: 0,
      date_added: "2026-09-01",
    });
  });

  it("会社の名前は fields.all.companyname から、ネストした項目はドット区切りで取る", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({
      total: 1,
      items: [{ id: 8, fields: { all: { companyname: "Acme", companycity: "Tokyo" } }, score: 5 }],
      meta: {},
    });
    const result = await call("mautic_list_records", { resource: "companies" });
    expect((result.structuredContent!.items as Items)[0]).toEqual({ id: 8, name: "Acme", "fields.all.companycity": "Tokyo", score: 5 });
  });

  it("要約の文字列は 300 文字を超えたら省略する", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 1, items: [{ id: 1, name: "n", description: "d".repeat(301) }], meta: {} });
    const result = await call("mautic_list_records", { resource: "campaigns" });
    expect((result.structuredContent!.items as Items)[0]!.description).toMatch(/^d{200}… \[omitted 301 chars/);
  });

  it("markdown でも structuredContent は JSON で、resource 名を含む", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 3, items: [{ id: 1, tag: "vip" }], meta: {} });
    const result = await call("mautic_list_records", { resource: "tags", limit: 1 });
    expect(result.content[0]!.text).toContain("# tags");
    expect(result.content[0]!.text).toContain("## vip (ID: 1)");
    expect(result.content[0]!.text).toContain("More results available: call again with offset=1.");
    expect(result.structuredContent).toMatchObject({ resource: "tags", total: 3, count: 1, has_more: true, next_offset: 1 });
  });

  it("0 件なら件数だけを Markdown で伝える", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 0, items: [], meta: {} });
    const result = await call("mautic_list_records", { resource: "forms" });
    expect(result.content[0]!.text).toBe("# forms\n\nNo records found (total: 0).");
  });

  it("response_format=json ならテキストも structuredContent と同じ JSON", async () => {
    const { call, getList } = setup();
    getList.mockResolvedValue({ total: 1, items: [{ id: 1, name: "a" }], meta: {} });
    const result = await call("mautic_list_records", { resource: "stages", response_format: "json" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("応答が大きすぎるときは件数を減らして案内を付ける", async () => {
    const { call, getList } = setup();
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: "n".repeat(290), description: "d".repeat(290) }));
    getList.mockResolvedValue({ total: 100, items, meta: {} });
    const result = await call("mautic_list_records", { resource: "campaigns", limit: 100 });
    expect(result.content[0]!.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(result.structuredContent!.truncation_message).toMatch(/^Response truncated/);
  });

  it("API エラーは isError の結果にする", async () => {
    const { call, getList } = setup();
    getList.mockRejectedValue(new MauticApiError(500, "boom"));
    const result = await call("mautic_list_records", { resource: "emails" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Mautic server error (500)");
  });
});

describe("mautic_get_record", () => {
  it("{path}/{id} を取得し、one のキーの中身を record として返す", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ list: { id: 3, name: "Newsletter", alias: "newsletter" } });
    const result = await call("mautic_get_record", { resource: "segments", id: 3 });
    expect(get).toHaveBeenCalledWith("/segments/3");
    expect(result.structuredContent).toEqual({ resource: "segments", record: { id: 3, name: "Newsletter", alias: "newsletter" } });
  });

  it("reports は API を呼ばずに専用ツールへ誘導するエラーを返す", async () => {
    const { call, get } = setup();
    const result = await call("mautic_get_record", { resource: "reports", id: 1 });
    expect(get).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Error: reports cannot be fetched with this tool. Use mautic_run_report to get a report's definition and data.");
  });

  it("秘匿情報を伏せ、長い文字列は既定で省略する", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ hook: { id: 1, secret: "whsec", webhookUrl: "https://example.com" } });
    const hook = await call("mautic_get_record", { resource: "webhooks", id: 1 });
    expect(hook.structuredContent!.record).toEqual({ id: 1, secret: "[redacted]", webhookUrl: "https://example.com" });

    get.mockResolvedValue({ email: { id: 2, customHtml: "h".repeat(LONG_TEXT_LIMIT + 1) } });
    const email = await call("mautic_get_record", { resource: "emails", id: 2 });
    expect((email.structuredContent!.record as { customHtml: string }).customHtml).toContain("include_long_text=true");
  });

  it("include_long_text=true なら長い文字列を省略しない", async () => {
    const { call, get } = setup();
    const html = "h".repeat(LONG_TEXT_LIMIT + 1);
    get.mockResolvedValue({ email: { id: 2, customHtml: html } });
    const result = await call("mautic_get_record", { resource: "emails", id: 2, include_long_text: true, response_format: "json" });
    expect((result.structuredContent!.record as { customHtml: string }).customHtml).toBe(html);
  });

  it("テキストが CHARACTER_LIMIT を超えたら切り詰めて案内を付ける（structuredContent は全体）", async () => {
    const { call, get } = setup();
    const html = "h".repeat(CHARACTER_LIMIT + 100);
    get.mockResolvedValue({ page: { id: 4, customHtml: html } });
    const result = await call("mautic_get_record", { resource: "pages", id: 4, include_long_text: true, response_format: "json" });
    expect(result.content[0]!.text).toContain(`… [truncated at ${CHARACTER_LIMIT} chars.`);
    expect((result.structuredContent!.record as { customHtml: string }).customHtml).toBe(html);
  });

  it("404 は Not found のエラーにする", async () => {
    const { call, get } = setup();
    get.mockRejectedValue(new MauticApiError(404, "Item was not found."));
    const result = await call("mautic_get_record", { resource: "emails", id: 999 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Verify the ID first");
  });
});

describe("renderRecord", () => {
  it("スカラーは箇条書き、オブジェクトは JSON のコードブロックにし、空の項目は省く", () => {
    const text = renderRecord("emails", { id: 3, name: "News", isPublished: false, empty: "", none: null, category: { id: 1 } });
    expect(text).toBe(
      ["# emails 3", "", "- **id**: 3", "- **name**: News", "- **isPublished**: false", "", "## category", "```json", '{\n  "id": 1\n}', "```"].join(
        "\n",
      ),
    );
  });
});
