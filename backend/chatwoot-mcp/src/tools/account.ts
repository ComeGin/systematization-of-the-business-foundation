import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { AccessLevel } from "../config.js";
import { ResponseFormatSchema } from "../schemas/common.js";
import { compact, errorResult, formattedResult, renderFields, sanitize } from "../services/results.js";
import type { ApiRecord, ToolContext } from "../types.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext, accessLevel: AccessLevel): void {
  server.registerTool(
    "chatwoot_get_account",
    {
      title: "Get Chatwoot Account",
      description: `Get the Chatwoot account settings (name, locale, timezone, domain, auto-resolve settings, enabled features)
and the user this MCP server acts as (name, role, availability). Read-only.

Call this first to learn whether the token's user is an administrator (needed for reports, audit logs and most settings)
and which write level this server allows (access_level: read_only / read_write / full).`,
      inputSchema: z.strictObject({ response_format: ResponseFormatSchema }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ response_format }) => {
      try {
        const [account, profile] = await Promise.all([
          ctx.client.get<ApiRecord>(""),
          ctx.client.get<ApiRecord>("/profile", { scope: "root" }),
        ]);
        const membership = ((profile.accounts as ApiRecord[] | undefined) ?? []).find((item) => item.id === ctx.client.accountId);
        const structured = {
          access_level: accessLevel,
          timezone_offset_hours: ctx.tz.offsetHours,
          account: sanitize(account) as ApiRecord,
          user: compact({
            id: profile.id,
            name: profile.name,
            display_name: profile.display_name,
            email: profile.email,
            role: membership?.role ?? profile.role,
            availability_status: membership?.availability_status,
          }),
        };
        return formattedResult(
          structured,
          response_format,
          () =>
            [
              `# Chatwoot account ${String(account.id)}: ${String(account.name)}`,
              "",
              `MCP access level: ${accessLevel} / time zone offset: UTC${ctx.tz.offsetHours >= 0 ? "+" : ""}${ctx.tz.offsetHours}`,
              "",
              "## Acting user",
              ...renderFields(structured.user),
              "",
              "## Account",
              ...renderFields(structured.account),
            ].join("\n"),
          "Use response_format='json'.",
        );
      } catch (error) {
        return errorResult(error, "Check CHATWOOT_ACCOUNT_ID: the token's user must belong to that account.");
      }
    },
  );
}
