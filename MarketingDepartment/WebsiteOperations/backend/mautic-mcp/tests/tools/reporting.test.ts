import { describe, expect, it } from "vitest";

import { MauticApiError } from "../../src/services/mautic-client.js";
import { registerReportingTools } from "../../src/tools/reporting.js";
import { createFakeClient, createFakeServer } from "../helpers/fake-server.js";

function setup() {
  const fake = createFakeServer();
  const client = createFakeClient();
  registerReportingTools(fake.server, client.client);
  return { ...fake, ...client };
}

describe("registerReportingTools", () => {
  it("3 ツールを参照専用で登録する", () => {
    const { tools } = setup();
    expect([...tools.keys()].sort()).toEqual(["mautic_get_dashboard_widget_data", "mautic_query_stats", "mautic_run_report"]);
    for (const tool of tools.values()) expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe("mautic_run_report", () => {
  it("/reports/{id} を期間・ページ指定で呼ぶ", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ data: [] });
    await call("mautic_run_report", { report_id: 3, date_from: "2026-08-01", date_to: "2026-08-31" });
    expect(get).toHaveBeenCalledWith("/reports/3", { dateFrom: "2026-08-01", dateTo: "2026-08-31", limit: 50, page: 1 });
  });

  it("limit の上限は 500", async () => {
    const { call } = setup();
    await expect(call("mautic_run_report", { report_id: 3, limit: 501 })).rejects.toThrow();
  });
});

describe("mautic_get_dashboard_widget_data", () => {
  it("widget_type がなければ種別一覧（/data）を返す", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ types: { "created.leads.in.time": "Created contacts" } });
    const result = await call("mautic_get_dashboard_widget_data");
    expect(get).toHaveBeenCalledWith("/data");
    expect(JSON.parse(result.content[0]!.text)).toEqual({ types: { "created.leads.in.time": "Created contacts" } });
  });

  it("widget_type があれば raw 形式でデータを取る", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ data: {} });
    await call("mautic_get_dashboard_widget_data", { widget_type: "created.leads.in.time", date_from: "2026-01-01", timezone: "Asia/Tokyo" });
    expect(get).toHaveBeenCalledWith("/data/created.leads.in.time", {
      dateFrom: "2026-01-01",
      dateTo: undefined,
      timeUnit: "m",
      limit: undefined,
      timezone: "Asia/Tokyo",
      dataFormat: "raw",
    });
  });

  it("widget_type にパス区切りなどは使えない", async () => {
    const { call, get } = setup();
    await expect(call("mautic_get_dashboard_widget_data", { widget_type: "../contacts" })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("404 は種別一覧を取り直すよう案内する", async () => {
    const { call, get } = setup();
    get.mockRejectedValue(new MauticApiError(404, "Not found"));
    const result = await call("mautic_get_dashboard_widget_data", { widget_type: "unknown.widget" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown widget_type; call this tool without widget_type to list valid types.");
  });
});

describe("mautic_query_stats", () => {
  it("table がなければ /stats を、ページングなしで呼ぶ", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ availableTables: ["email_stats"] });
    await call("mautic_query_stats");
    expect(get).toHaveBeenCalledWith("/stats", { where: undefined, order: undefined, start: undefined, limit: undefined });
  });

  it("where と order_by を Mautic の形に変換し、in / notIn の値はカンマで分割する", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ total: 0, stats: [] });
    await call("mautic_query_stats", {
      table: "email_stats",
      where: [
        { column: "email_id", expr: "in", value: "1,2,3" },
        { column: "lead_id", expr: "notIn", value: "9" },
        { column: "is_read", expr: "eq", value: "1" },
        { column: "date_read", expr: "isNotNull" },
      ],
      order_by: [{ column: "date_sent", direction: "desc" }, { column: "id" }],
      limit: 10,
      offset: 5,
    });
    expect(get).toHaveBeenCalledWith("/stats/email_stats", {
      where: [
        { col: "email_id", expr: "in", val: ["1", "2", "3"] },
        { col: "lead_id", expr: "notIn", val: ["9"] },
        { col: "is_read", expr: "eq", val: "1" },
        { col: "date_read", expr: "isNotNull", val: undefined },
      ],
      order: [
        { col: "date_sent", dir: "DESC" },
        { col: "id", dir: "ASC" },
      ],
      start: 5,
      limit: 10,
    });
  });

  it("存在しないテーブルで一覧が返ってきたら、使えるテーブルを添えてエラーにする", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ availableTables: ["email_stats", "page_hits"], tableColumns: {} });
    const result = await call("mautic_query_stats", { table: "no_such_table" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Error: Unknown stats table 'no_such_table'. Available tables: email_stats, page_hits");
  });

  it("availableTables が配列でなければ unknown と伝える", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({});
    const result = await call("mautic_query_stats", { table: "x" });
    expect(result.content[0]!.text).toBe("Error: Unknown stats table 'x'. Available tables: unknown");
  });

  it("stats を含む応答はそのまま JSON で返す", async () => {
    const { call, get } = setup();
    get.mockResolvedValue({ total: "1", stats: [{ id: "1" }] });
    const result = await call("mautic_query_stats", { table: "page_hits" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ total: "1", stats: [{ id: "1" }] });
  });

  it("列名・テーブル名に記号は使えず、where は 10 件・order_by は 3 件まで", async () => {
    const { call } = setup();
    await expect(call("mautic_query_stats", { table: "email_stats; drop" })).rejects.toThrow();
    await expect(call("mautic_query_stats", { table: "t", where: [{ column: "a b", expr: "eq", value: "1" }] })).rejects.toThrow();
    const where = Array.from({ length: 11 }, () => ({ column: "id", expr: "eq", value: "1" }));
    await expect(call("mautic_query_stats", { table: "t", where })).rejects.toThrow();
    const order = Array.from({ length: 4 }, () => ({ column: "id" }));
    await expect(call("mautic_query_stats", { table: "t", order_by: order })).rejects.toThrow();
  });

  it("未知の演算子は拒否する", async () => {
    const { call } = setup();
    await expect(call("mautic_query_stats", { table: "t", where: [{ column: "id", expr: "regexp", value: "." }] })).rejects.toThrow();
  });
});
