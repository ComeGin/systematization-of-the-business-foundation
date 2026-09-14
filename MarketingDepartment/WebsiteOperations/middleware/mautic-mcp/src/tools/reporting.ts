import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { DateSchema, IdSchema, LimitSchema, OffsetSchema } from "../schemas/common.js";
import type { MauticClient } from "../services/mautic-client.js";
import { errorResult, errorText, jsonResult } from "../services/results.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

// Mautic の Stats API の where 条件で使える演算子（QueryBuilder の expr）
const STATS_EXPRESSIONS = ["eq", "neq", "lt", "lte", "gt", "gte", "like", "notLike", "in", "notIn", "isNull", "isNotNull"] as const;

export function registerReportingTools(server: McpServer, client: MauticClient): void {
  server.registerTool(
    "mautic_run_report",
    {
      title: "Run Mautic Report",
      description: `Run a saved Mautic report and return its rows. Read-only.

Returns JSON with the report definition (name, source, columns, filters) and data rows, plus totals and paging fields.
Find report IDs with mautic_list_records (resource="reports").

Examples:
  - "Rows of report 3 for August 2026" -> report_id=3, date_from="2026-08-01", date_to="2026-08-31"
  - "First 50 rows only" -> limit=50, page=1`,
      inputSchema: z.strictObject({
        report_id: IdSchema("Report"),
        date_from: DateSchema.optional().describe("Start of the report date range (YYYY-MM-DD)"),
        date_to: DateSchema.optional().describe("End of the report date range (YYYY-MM-DD)"),
        limit: LimitSchema(500, 50).describe("Rows per page (1-500, default 50)"),
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1 (default 1)"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ report_id, date_from, date_to, limit, page }) => {
      try {
        const data = await client.get<unknown>(`/reports/${report_id}`, { dateFrom: date_from, dateTo: date_to, limit, page });
        return jsonResult(data, "Use a smaller limit or a narrower date range.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_get_dashboard_widget_data",
    {
      title: "Get Mautic Dashboard Widget Data",
      description: `Get the data behind a Mautic dashboard widget (charts and tables such as created contacts over time, email stats, page hits). Read-only.

Call without widget_type first to get the available widget types. Then call with a widget_type to get its data
(chart data is returned as { "<dataset label>": { "<period label>": value } }).

Examples:
  - "New contacts per month in 2026" -> widget_type="created.leads.in.time", date_from="2026-01-01", date_to="2026-12-31", time_unit="m"
  - "Which widget types exist?" -> no arguments`,
      inputSchema: z.strictObject({
        widget_type: z
          .string()
          .regex(/^[a-z0-9._-]+$/i, "Use a widget type returned by calling this tool without arguments")
          .optional()
          .describe("Widget type key, e.g. 'created.leads.in.time'. Omit to list types."),
        date_from: DateSchema.optional().describe("Start date (YYYY-MM-DD). Defaults to Mautic's default range."),
        date_to: DateSchema.optional().describe("End date (YYYY-MM-DD)"),
        time_unit: z
          .enum(["H", "d", "W", "m", "Y"])
          .default("m")
          .describe("Grouping for time charts: H=hour, d=day, W=week, m=month, Y=year (default 'm')"),
        limit: z.number().int().min(1).max(100).optional().describe("Row limit for table widgets"),
        timezone: z.string().max(64).optional().describe("IANA timezone for date grouping, e.g. 'Asia/Tokyo'"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ widget_type, date_from, date_to, time_unit, limit, timezone }) => {
      try {
        if (!widget_type) {
          return jsonResult(await client.get<unknown>("/data"), "");
        }
        const data = await client.get<unknown>(`/data/${widget_type}`, {
          dateFrom: date_from,
          dateTo: date_to,
          timeUnit: time_unit,
          limit,
          timezone,
          dataFormat: "raw",
        });
        return jsonResult(data, "Use a narrower date range or a coarser time_unit.");
      } catch (error) {
        return errorResult(error, "Unknown widget_type; call this tool without widget_type to list valid types.");
      }
    },
  );

  server.registerTool(
    "mautic_query_stats",
    {
      title: "Query Mautic Stats Tables",
      description: `Query Mautic's raw statistics tables (e.g. email_stats, page_hits, form_submissions, campaign_lead_event_log, lead_points_change_log). Read-only.

Call without table first to get available tables and their columns. Then query one table with optional where filters and ordering.
Returns JSON: { total, stats: [rows] }.

Examples:
  - "Tables and columns?" -> no arguments
  - "Opens of email 5" -> table="email_stats", where=[{column:"email_id", expr:"eq", value:"5"}, {column:"is_read", expr:"eq", value:"1"}]
  - "Latest page hits" -> table="page_hits", order_by=[{column:"date_hit", direction:"desc"}], limit=20`,
      inputSchema: z.strictObject({
        table: z
          .string()
          .regex(/^[a-z0-9_]+$/, "Use a table name returned by calling this tool without arguments")
          .optional()
          .describe("Stats table name. Omit to list tables and columns."),
        where: z
          .array(
            z.strictObject({
              column: z.string().regex(/^[a-z0-9_]+$/),
              expr: z.enum(STATS_EXPRESSIONS),
              value: z.string().max(200).optional().describe("Comparison value (omit for isNull/isNotNull; comma-separated for in/notIn)"),
            }),
          )
          .max(10)
          .optional()
          .describe("Filter conditions, combined with AND"),
        order_by: z
          .array(z.strictObject({ column: z.string().regex(/^[a-z0-9_]+$/), direction: z.enum(["asc", "desc"]).default("asc") }))
          .max(3)
          .optional(),
        limit: LimitSchema(500, 50),
        offset: OffsetSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ table, where, order_by, limit, offset }) => {
      try {
        const data = await client.get<Record<string, unknown>>(table ? `/stats/${table}` : "/stats", {
          where: where?.map(({ column, expr, value }) => ({ col: column, expr, val: expr === "in" || expr === "notIn" ? value?.split(",") : value })),
          order: order_by?.map(({ column, direction }) => ({ col: column, dir: direction.toUpperCase() })),
          start: table ? offset : undefined,
          limit: table ? limit : undefined,
        });
        // 存在しないテーブルを指定すると、Mautic はエラーにせずテーブル一覧を返す
        if (table && !("stats" in data)) {
          const tables = Array.isArray(data.availableTables) ? data.availableTables.join(", ") : "unknown";
          return errorText(`Error: Unknown stats table '${table}'. Available tables: ${tables}`);
        }
        return jsonResult(data, "Add where filters or use a smaller limit.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
