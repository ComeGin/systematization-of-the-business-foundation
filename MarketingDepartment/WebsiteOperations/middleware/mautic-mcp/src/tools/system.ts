import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { MauticClient } from "../services/mautic-client.js";
import { errorResult, jsonResult } from "../services/results.js";
import { READ_ONLY_ANNOTATIONS } from "./annotations.js";

const LOOKUPS = {
  point_action_types: { path: "/points/actions/types", description: "action types usable in point actions" },
  point_trigger_event_types: { path: "/points/triggers/events/types", description: "event types usable in point triggers" },
  webhook_triggers: { path: "/hooks/triggers", description: "events a webhook can subscribe to" },
  contact_owners: { path: "/contacts/list/owners", description: "users who can own contacts (id, name)" },
} as const;

type LookupName = keyof typeof LOOKUPS;

export function registerSystemTools(server: McpServer, client: MauticClient): void {
  server.registerTool(
    "mautic_list_files",
    {
      title: "List Mautic Media Files",
      description: `List file names uploaded to Mautic's media library. Read-only (file contents are not returned).

dir: 'images' for images used in emails/pages, 'media' for the whole media directory. Use subdir for nested folders (e.g. 'files').`,
      inputSchema: z.strictObject({
        dir: z.enum(["images", "media"]).default("images").describe("Directory to list (default 'images')"),
        subdir: z
          .string()
          .regex(/^[A-Za-z0-9_/-]*$/, "Letters, digits, '_', '-' and '/' only")
          .max(200)
          .optional()
          .describe("Sub directory inside dir, e.g. 'files'"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ dir, subdir }) => {
      try {
        return jsonResult(await client.get<unknown>(`/files/${dir}`, { subdir }), "Narrow down with subdir.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_list_themes",
    {
      title: "List Mautic Themes",
      description: "List installed Mautic themes (templates for emails, landing pages, forms) with their names and supported features. Read-only.",
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        return jsonResult(await client.get<unknown>("/themes"), "");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "mautic_list_lookup",
    {
      title: "List Mautic Lookup Values",
      description: `List reference values used when reading configuration. Read-only.

kind:
${Object.entries(LOOKUPS).map(([name, lookup]) => `  - ${name}: ${lookup.description}`).join("\n")}`,
      inputSchema: z.strictObject({
        kind: z.enum(Object.keys(LOOKUPS) as [LookupName, ...LookupName[]]).describe("Which lookup list to return"),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kind }) => {
      try {
        return jsonResult(await client.get<unknown>(LOOKUPS[kind].path), "");
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
