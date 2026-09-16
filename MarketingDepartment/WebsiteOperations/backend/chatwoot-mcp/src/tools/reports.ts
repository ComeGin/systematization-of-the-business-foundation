import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { PAGE_SIZE } from "../constants.js";
import { DateTimeSchema, IdSchema, PageSchema } from "../schemas/common.js";
import { errorResult, errorText, jsonResult } from "../services/results.js";
import { resolveRange, type UnixRange } from "../services/time.js";
import type { ApiRecord, ToolContext } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

const METRICS = [
  "conversations_count",
  "incoming_messages_count",
  "outgoing_messages_count",
  "avg_first_response_time",
  "avg_resolution_time",
  "reply_time",
  "resolutions_count",
  "bot_resolutions_count",
  "bot_handoffs_count",
] as const;

const DIMENSIONS = ["account", "agent", "inbox", "label", "team"] as const;

const BREAKDOWNS = {
  by_agent: { path: "/summary_reports/agent", names: "/agents", description: "conversation / resolution counts and avg times per agent" },
  by_inbox: { path: "/summary_reports/inbox", names: "/inboxes", description: "the same metrics per inbox" },
  by_team: { path: "/summary_reports/team", names: "/teams", description: "the same metrics per team" },
  by_label: { path: "/summary_reports/label", names: "/labels", description: "the same metrics per label" },
  by_channel: { path: "/summary_reports/channel", description: "conversation counts per channel type and status (range up to 6 months)" },
  first_response_time_distribution: {
    path: "/reports/first_response_time_distribution",
    description: "conversations per first-response-time bucket (0-1h, 1-4h, 4-8h, 8-24h, 24h+) per channel",
  },
  inbox_label_matrix: { path: "/reports/inbox_label_matrix", description: "conversation counts for each inbox x label combination" },
  outgoing_messages_by_agent: { path: "/reports/outgoing_messages_count", groupBy: "agent", description: "outgoing message counts per agent (bots excluded)" },
  outgoing_messages_by_team: { path: "/reports/outgoing_messages_count", groupBy: "team", description: "outgoing message counts per team" },
  outgoing_messages_by_inbox: { path: "/reports/outgoing_messages_count", groupBy: "inbox", description: "outgoing message counts per inbox" },
  outgoing_messages_by_label: { path: "/reports/outgoing_messages_count", groupBy: "label", description: "outgoing message counts per label" },
} as const satisfies Record<string, { path: string; description: string; names?: string; groupBy?: string }>;

type BreakdownName = keyof typeof BREAKDOWNS;

const SinceSchema = DateTimeSchema.optional().describe("Start of the period: YYYY-MM-DD or ISO 8601 (default: 30 days before until)");
const UntilSchema = DateTimeSchema.optional().describe("End of the period: YYYY-MM-DD (inclusive, whole day) or ISO 8601 (default: now)");
const BusinessHoursSchema = z.boolean().default(false).describe("Count time metrics only within the inbox working hours (default false)");

const TIME_NOTE = "Time metrics (avg_first_response_time, avg_resolution_time, reply_time, avg_*) are in seconds.";

function rangeInfo(ctx: ToolContext, range: UnixRange) {
  return { since: ctx.tz.format(range.since), until: ctx.tz.format(range.until) };
}

/** 集計対象の名前を ID から引けるようにする（集計 API は ID しか返さない） */
async function nameMap(ctx: ToolContext, path: string): Promise<Map<number, string>> {
  const data = await ctx.client.get<unknown>(path);
  const items = (Array.isArray(data) ? data : ((data as { payload?: unknown }).payload ?? [])) as ApiRecord[];
  return new Map(items.map((item) => [Number(item.id), String(item.available_name ?? item.name ?? item.title ?? item.id)]));
}

export function registerReportTools(server: McpServer, ctx: ToolContext): void {
  const { client, tz } = ctx;

  server.registerTool(
    "chatwoot_get_report_summary",
    {
      title: "Get Chatwoot Report Summary",
      description: `Get support KPIs for a period, with the same-length previous period for comparison: conversations_count,
incoming/outgoing_messages_count, avg_first_response_time, avg_resolution_time, reply_time, resolutions_count. Read-only.
Requires an administrator token.

type selects the scope: account (whole account), or one agent / inbox / label / team given by id.
${TIME_NOTE}

Examples:
  - "How did support do last month?" -> since="2026-08-01", until="2026-08-31"
  - "Inbox 2's first response time this week" -> type="inbox", id=2, since="2026-09-14"`,
      inputSchema: z.strictObject({
        type: z.enum(DIMENSIONS).default("account").describe("Scope of the report (default 'account')"),
        id: IdSchema("Agent / inbox / label / team").optional().describe("Required unless type='account'"),
        since: SinceSchema,
        until: UntilSchema,
        business_hours: BusinessHoursSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ type, id, since, until, business_hours }) => {
      if (type !== "account" && id === undefined) return errorText(`Error: id is required when type='${type}'. Find IDs with chatwoot_list_records.`);
      try {
        const range = resolveRange(tz, since, until);
        const data = await client.get<ApiRecord>("/reports/summary", {
          scope: "v2",
          query: { type, id, ...range, business_hours, timezone_offset: tz.offsetHours },
        });
        return jsonResult({ type, id, period: rangeInfo(ctx, range), note: TIME_NOTE, summary: data }, "");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_get_report_timeseries",
    {
      title: "Get Chatwoot Report Time Series",
      description: `Get one metric over time (per hour / day / week / month / year) for the account or one agent / inbox / label / team. Read-only.
Requires an administrator token.

Returns points [{ period_start, value }] in the server's time zone. ${TIME_NOTE}

Examples:
  - "Daily new conversations in September" -> metric="conversations_count", since="2026-09-01", until="2026-09-30"
  - "Monthly resolution time trend for team 1" -> metric="avg_resolution_time", type="team", id=1, group_by="month", since="2026-01-01"
  - "Busiest hours yesterday" -> metric="incoming_messages_count", group_by="hour", since="2026-09-15", until="2026-09-15"`,
      inputSchema: z.strictObject({
        metric: z.enum(METRICS).describe("Metric to chart"),
        type: z.enum(DIMENSIONS).default("account").describe("Scope (default 'account')"),
        id: IdSchema("Agent / inbox / label / team").optional().describe("Required unless type='account'"),
        group_by: z.enum(["hour", "day", "week", "month", "year"]).default("day").describe("Bucket size (default 'day')"),
        since: SinceSchema,
        until: UntilSchema,
        business_hours: BusinessHoursSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ metric, type, id, group_by, since, until, business_hours }) => {
      if (type !== "account" && id === undefined) return errorText(`Error: id is required when type='${type}'. Find IDs with chatwoot_list_records.`);
      try {
        const range = resolveRange(tz, since, until);
        const data = await client.get<{ value: unknown; timestamp: number; count?: number }[]>("/reports", {
          scope: "v2",
          query: { metric, type, id, group_by, ...range, business_hours, timezone_offset: tz.offsetHours },
        });
        const points = (Array.isArray(data) ? data : []).map((point) => ({
          period_start: tz.format(point.timestamp) ?? tz.format(new Date(point.timestamp * 1000).toISOString()),
          value: typeof point.value === "string" ? Number(point.value) : point.value,
          ...(point.count === undefined ? {} : { count: point.count }),
        }));
        return jsonResult({ metric, type, id, group_by, period: rangeInfo(ctx, range), points }, "Use a larger group_by or a shorter period.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_get_report_breakdown",
    {
      title: "Get Chatwoot Report Breakdown",
      description: `Compare support metrics across agents, inboxes, teams, labels or channels for a period. Read-only.
Requires an administrator token.

kind:
${Object.entries(BREAKDOWNS).map(([name, breakdown]) => `  - ${name}: ${breakdown.description}`).join("\n")}

Rows for agents / inboxes / teams / labels include a name. ${TIME_NOTE}

Examples:
  - "Which agent resolved the most last month?" -> kind="by_agent", since="2026-08-01", until="2026-08-31"
  - "How fast do we answer on each channel?" -> kind="first_response_time_distribution"`,
      inputSchema: z.strictObject({
        kind: z.enum(Object.keys(BREAKDOWNS) as [BreakdownName, ...BreakdownName[]]).describe("Which breakdown (see tool description)"),
        since: SinceSchema,
        until: UntilSchema,
        business_hours: BusinessHoursSchema.describe("by_agent / by_inbox / by_team / by_label only"),
        inbox_ids: z.array(IdSchema("Inbox")).max(50).optional().describe("inbox_label_matrix only: limit to these inboxes"),
        label_ids: z.array(IdSchema("Label")).max(50).optional().describe("inbox_label_matrix only: limit to these labels"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kind, since, until, business_hours, inbox_ids, label_ids }) => {
      const breakdown: { path: string; names?: string; groupBy?: string } = BREAKDOWNS[kind];
      try {
        const range = resolveRange(tz, since, until);
        const [data, names] = await Promise.all([
          client.get<unknown>(breakdown.path, {
            scope: "v2",
            query: { ...range, business_hours, inbox_ids, label_ids, group_by: breakdown.groupBy, timezone_offset: tz.offsetHours },
          }),
          breakdown.names ? nameMap(ctx, breakdown.names) : Promise.resolve(undefined),
        ]);
        const rows = Array.isArray(data) && names ? (data as ApiRecord[]).map((row) => ({ id: row.id, name: names.get(Number(row.id)) ?? null, ...row })) : data;
        return jsonResult({ kind, period: rangeInfo(ctx, range), note: TIME_NOTE, data: rows }, "Use a shorter period.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_get_live_conversation_stats",
    {
      title: "Get Chatwoot Live Conversation Stats",
      description: `Get the current workload (not tied to a period): numbers of open, unattended, unassigned and pending conversations
for the whole account, or per agent (open / unattended per agent, busiest first). Read-only. Requires an administrator token.

Examples:
  - "How many inquiries are waiting right now?" -> scope="account"
  - "Who has the most open conversations?" -> scope="agent"`,
      inputSchema: z.strictObject({
        scope: z.enum(["account", "agent"]).default("account").describe("'account' totals or per 'agent' (default 'account')"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ scope }) => {
      try {
        const data = await client.get<unknown>("/reports/conversations", { scope: "v2", query: { type: scope } });
        return jsonResult({ scope, as_of: tz.format(Math.floor(Date.now() / 1000)), data }, "");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_list_reporting_events",
    {
      title: "List Chatwoot Reporting Events",
      description: `List raw metric events, newest first: first_response, reply_time, conversation_resolved, conversation_bot_handoff, etc.
Each event has value (seconds), the conversation, inbox and agent. Read-only. Requires an administrator token.

Page size is fixed at ${PAGE_SIZE.reportingEvents}. For totals and averages prefer chatwoot_get_report_summary.

Examples:
  - "Slowest first responses this week" -> name="first_response", since="2026-09-14"
  - "Resolutions by agent 3 yesterday" -> name="conversation_resolved", user_id=3, since="2026-09-15", until="2026-09-15"`,
      inputSchema: z.strictObject({
        name: z.string().trim().min(1).max(100).optional().describe("Event name, e.g. first_response, reply_time, conversation_resolved"),
        inbox_id: IdSchema("Inbox").optional(),
        user_id: IdSchema("Agent (user)").optional(),
        since: DateTimeSchema.optional().describe("Only events at or after this date (YYYY-MM-DD or ISO 8601)"),
        until: DateTimeSchema.optional().describe("Only events up to this date (YYYY-MM-DD inclusive, or ISO 8601)"),
        page: PageSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ name, inbox_id, user_id, since, until, page }) => {
      try {
        const data = await client.get<{ payload: ApiRecord[]; meta: { count: number; current_page: number; total_pages: number } }>("/reporting_events", {
          query: {
            name,
            inbox_id,
            user_id,
            since: since ? tz.toUnix(since) : undefined,
            until: until ? tz.toUnix(until, true) : undefined,
            page,
          },
        });
        const hasMore = page < data.meta.total_pages;
        return jsonResult(
          { page, total: data.meta.count, has_more: hasMore, ...(hasMore ? { next_page: page + 1 } : {}), events: data.payload },
          `Call again with page=${page + 1}, or narrow the filters.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "chatwoot_list_audit_logs",
    {
      title: "List Chatwoot Audit Logs",
      description: `List audit log entries (who changed which settings, sign-ins, etc.), newest first. Read-only. Requires an administrator token.
Available only when the audit_logs feature is enabled (Enterprise); otherwise the result is always empty.

Page size is fixed at ${PAGE_SIZE.auditLogs}.`,
      inputSchema: z.strictObject({
        q: z.string().trim().min(1).max(200).optional().describe("Name or email of the user who performed the action"),
        types: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Audited record types, e.g. ['Inbox','Webhook','AccountUser']"),
        since: DateTimeSchema.optional().describe("Only entries at or after this date"),
        until: DateTimeSchema.optional().describe("Only entries up to this date (YYYY-MM-DD inclusive)"),
        sort: z.enum(["desc", "asc"]).default("desc").describe("Order by time (default 'desc')"),
        page: PageSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ q, types, since, until, sort, page }) => {
      try {
        const data = await client.get<{ total_entries: number; audit_logs: ApiRecord[] }>("/audit_logs", {
          query: { q, types, since: since ? tz.toUnix(since) : undefined, until: until ? tz.toUnix(until, true) : undefined, sort, page },
        });
        const hasMore = page * PAGE_SIZE.auditLogs < data.total_entries;
        return jsonResult(
          { page, total: data.total_entries, has_more: hasMore, ...(hasMore ? { next_page: page + 1 } : {}), audit_logs: data.audit_logs },
          `Call again with page=${page + 1}, or narrow the filters.`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
