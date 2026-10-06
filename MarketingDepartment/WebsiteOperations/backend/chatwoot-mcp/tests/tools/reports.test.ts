import { afterEach, describe, expect, it, vi } from "vitest";

import { READ_ONLY_ANNOTATIONS } from "../../src/tools/annotations.js";
import { registerReportTools } from "../../src/tools/reports.js";
import { installFetch, routes, V1, V2 } from "../helpers/fetch.js";
import { createFakeServer, jsonOf, makeCtx, textOf } from "../helpers/server.js";

function setup() {
  const fake = createFakeServer();
  registerReportTools(fake.server, makeCtx());
  return fake;
}

const unix = (iso: string) => Date.parse(iso) / 1000;
const SEPT = { since: String(unix("2026-09-01T00:00:00+09:00")), until: String(unix("2026-09-30T23:59:59+09:00")) };

afterEach(() => {
  vi.useRealTimers();
});

describe("registerReportTools", () => {
  it("レポート系 6 ツールを参照専用の注釈で登録する", () => {
    const fake = setup();
    expect(fake.names()).toEqual([
      "chatwoot_get_report_summary",
      "chatwoot_get_report_timeseries",
      "chatwoot_get_report_breakdown",
      "chatwoot_get_live_conversation_stats",
      "chatwoot_list_reporting_events",
      "chatwoot_list_audit_logs",
    ]);
    for (const { config } of fake.tools.values()) expect(config.annotations).toEqual(READ_ONLY_ANNOTATIONS);
  });
});

describe("chatwoot_get_report_summary", () => {
  it("v2 の /reports/summary に、日付を設定した時差で Unix 秒にして渡す", async () => {
    const { calls } = installFetch(routes({ [`GET ${V2}/reports/summary`]: { json: { conversations_count: 3 } } }));
    const result = await setup().call("chatwoot_get_report_summary", { since: "2026-09-01", until: "2026-09-30" });
    expect(Object.fromEntries(calls[0]!.query)).toEqual({ type: "account", ...SEPT, business_hours: "false", timezone_offset: "9" });
    expect(jsonOf(result)).toMatchObject({
      type: "account",
      period: { since: "2026-09-01T00:00:00+09:00", until: "2026-09-30T23:59:59+09:00" },
      summary: { conversations_count: 3 },
    });
  });

  it("期間を省略すると今から 30 日前までにする", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
    const { calls } = installFetch(() => ({ json: {} }));
    await setup().call("chatwoot_get_report_summary");
    const now = unix("2026-09-16T00:00:00Z");
    expect(calls[0]!.query.get("until")).toBe(String(now));
    expect(calls[0]!.query.get("since")).toBe(String(now - 30 * 86_400));
  });

  it("type が account 以外で id がないときは API を呼ばずに拒否する", async () => {
    const { calls } = installFetch(() => ({ json: {} }));
    const result = await setup().call("chatwoot_get_report_summary", { type: "inbox" });
    expect(calls).toHaveLength(0);
    expect(textOf(result)).toBe("Error: id is required when type='inbox'. Find IDs with chatwoot_list_records.");
  });

  it("since が until 以降なら API を呼ばずにエラーにする", async () => {
    const { calls } = installFetch(() => ({ json: {} }));
    const result = await setup().call("chatwoot_get_report_summary", { since: "2026-10-01", until: "2026-09-01" });
    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Error: since must be earlier than until.");
  });

  it("存在しない月の日付はエラーにする", async () => {
    installFetch(() => ({ json: {} }));
    expect(textOf(await setup().call("chatwoot_get_report_summary", { since: "2026-13-01" }))).toContain("Invalid date '2026-13-01'");
  });
});

describe("chatwoot_get_report_timeseries", () => {
  it("v2 の /reports に指標と粒度を渡し、値を数値に・時刻を ISO 8601 に直す", async () => {
    const t = unix("2026-09-01T00:00:00+09:00");
    const { calls } = installFetch(routes({ [`GET ${V2}/reports`]: { json: [{ value: "12.5", timestamp: t }, { value: 3, timestamp: t + 86_400, count: 2 }] } }));
    const result = await setup().call("chatwoot_get_report_timeseries", { metric: "avg_first_response_time", type: "team", id: 1, group_by: "week", since: "2026-09-01", until: "2026-09-30" });
    expect(calls[0]!.query.get("metric")).toBe("avg_first_response_time");
    expect(calls[0]!.query.get("group_by")).toBe("week");
    expect(calls[0]!.query.get("id")).toBe("1");
    expect(jsonOf(result).points).toEqual([
      { period_start: "2026-09-01T00:00:00+09:00", value: 12.5 },
      { period_start: "2026-09-02T00:00:00+09:00", value: 3, count: 2 },
    ]);
  });
});

describe("chatwoot_get_report_breakdown", () => {
  it("担当者別は v2 の集計と v1 の担当者一覧を取り、行に名前を付ける", async () => {
    const { calls } = installFetch(
      routes({
        [`GET ${V2}/summary_reports/agent`]: { json: [{ id: 5, conversations_count: 4 }, { id: 9, conversations_count: 1 }] },
        [`GET ${V1}/agents`]: { json: [{ id: 5, available_name: "Hanako" }] },
      }),
    );
    const result = await setup().call("chatwoot_get_report_breakdown", { kind: "by_agent", since: "2026-09-01", until: "2026-09-30" });
    expect(calls.map((call) => call.path).sort()).toEqual([`${V1}/agents`, `${V2}/summary_reports/agent`]);
    expect(jsonOf(result).data).toEqual([
      { id: 5, name: "Hanako", conversations_count: 4 },
      { id: 9, name: null, conversations_count: 1 },
    ]);
  });

  it("送信メッセージ数のチーム別は group_by=team を付け、名前の一覧は取らない", async () => {
    const { calls } = installFetch(routes({ [`GET ${V2}/reports/outgoing_messages_count`]: { json: [] } }));
    await setup().call("chatwoot_get_report_breakdown", { kind: "outgoing_messages_by_team" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query.get("group_by")).toBe("team");
  });

  it("受信箱×ラベルの表は inbox_ids / label_ids を配列のクエリで渡す", async () => {
    const { calls } = installFetch(routes({ [`GET ${V2}/reports/inbox_label_matrix`]: { json: {} } }));
    await setup().call("chatwoot_get_report_breakdown", { kind: "inbox_label_matrix", inbox_ids: [1, 2], label_ids: [3] });
    expect(calls[0]!.query.getAll("inbox_ids[]")).toEqual(["1", "2"]);
    expect(calls[0]!.query.getAll("label_ids[]")).toEqual(["3"]);
  });
});

describe("chatwoot_get_live_conversation_stats", () => {
  it("v2 の /reports/conversations に type=scope を渡す", async () => {
    const { calls } = installFetch(routes({ [`GET ${V2}/reports/conversations`]: { json: { open: 3 } } }));
    const result = await setup().call("chatwoot_get_live_conversation_stats", { scope: "agent" });
    expect(calls[0]!.query.get("type")).toBe("agent");
    expect(jsonOf(result)).toMatchObject({ scope: "agent", data: { open: 3 } });
  });
});

describe("chatwoot_list_reporting_events", () => {
  it("v1 の /reporting_events に日付を Unix 秒で渡し、total_pages から続きの有無を決める", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}/reporting_events`]: { json: { payload: [{ id: 1 }], meta: { count: 60, current_page: 1, total_pages: 3 } } } }));
    const result = await setup().call("chatwoot_list_reporting_events", { name: "first_response", since: "2026-09-01", until: "2026-09-30" });
    expect(calls[0]!.query.get("since")).toBe(SEPT.since);
    expect(calls[0]!.query.get("until")).toBe(SEPT.until);
    expect(jsonOf(result)).toMatchObject({ page: 1, total: 60, has_more: true, next_page: 2, events: [{ id: 1 }] });
  });

  it("最終ページでは has_more=false で next_page を付けない", async () => {
    installFetch(routes({ [`GET ${V1}/reporting_events`]: { json: { payload: [], meta: { count: 60, current_page: 3, total_pages: 3 } } } }));
    const body = jsonOf(await setup().call("chatwoot_list_reporting_events", { page: 3 }));
    expect(body.has_more).toBe(false);
    expect(body).not.toHaveProperty("next_page");
  });
});

describe("chatwoot_list_audit_logs", () => {
  it("v1 の /audit_logs に種別を配列のクエリで渡し、固定ページ件数（25）で続きの有無を決める", async () => {
    const { calls } = installFetch(routes({ [`GET ${V1}/audit_logs`]: { json: { total_entries: 26, audit_logs: [{ id: 1 }] } } }));
    const result = await setup().call("chatwoot_list_audit_logs", { types: ["Inbox", "Webhook"] });
    expect(calls[0]!.query.getAll("types[]")).toEqual(["Inbox", "Webhook"]);
    expect(calls[0]!.query.get("sort")).toBe("desc");
    expect(jsonOf(result)).toMatchObject({ total: 26, has_more: true, next_page: 2 });
  });

  it("402（機能なし）はプラン制限として返す", async () => {
    installFetch(() => ({ status: 402, json: { error: "audit_logs is not enabled" } }));
    const result = await setup().call("chatwoot_list_audit_logs");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not available on the current Chatwoot plan");
  });
});
