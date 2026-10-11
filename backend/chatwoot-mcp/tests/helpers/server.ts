import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { vi } from "vitest";

import { ChatwootClient } from "../../src/services/chatwoot-client.js";
import { TimeZone } from "../../src/services/time.js";
import type { ToolContext } from "../../src/types.js";
import { ACCOUNT_ID } from "./fetch.js";

export const BASE_URL = "https://chatwoot.test";
export const ACCESS_TOKEN = "test-user-access-token-1234567890";

/** 実物の ChatwootClient（fetch は各テストで差し替える）と UTC+9 の TimeZone */
export function makeCtx(offsetHours = 9): ToolContext {
  return {
    client: new ChatwootClient({ baseUrl: BASE_URL, accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }),
    tz: new TimeZone(offsetHours),
  };
}

interface RegisteredTool {
  config: any;
  handler: (args: unknown, extra?: unknown) => Promise<CallToolResult>;
}

/**
 * registerTool を記録するだけの McpServer。
 * call() は SDK と同じく inputSchema で入力を検証（既定値の補完を含む）してからハンドラを呼ぶ。
 */
export function createFakeServer() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: vi.fn((name: string, config: unknown, handler: RegisteredTool["handler"]) => {
      if (tools.has(name)) throw new Error(`ツール名が重複しています: ${name}`);
      tools.set(name, { config, handler });
    }),
  };

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`未登録のツールです: ${name}`);
    return tool.handler(tool.config.inputSchema.parse(args), {});
  }

  return { server: server as unknown as McpServer, tools, call, names: () => [...tools.keys()] };
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("text の content がありません");
  return first.text;
}

/** jsonResult() で返したツールの本文を読む */
export function jsonOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

// ---- テスト用の Chatwoot レスポンス ----

export function conversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    uuid: "uuid-42",
    inbox_id: 1,
    status: "open",
    priority: null,
    labels: [],
    muted: false,
    can_reply: true,
    unread_count: 0,
    created_at: 1_789_000_000,
    last_activity_at: 1_789_000_100,
    waiting_since: 0,
    first_reply_created_at: 0,
    snoozed_until: null,
    custom_attributes: {},
    additional_attributes: {},
    last_non_activity_message: null,
    meta: { sender: contact(), channel: "Channel::Api", assignee: null, team: null },
    ...overrides,
  };
}

export function contact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    name: "山田 太郎",
    email: "taro@example.com",
    phone_number: null,
    identifier: null,
    additional_attributes: {},
    custom_attributes: {},
    contact_inboxes: [],
    ...overrides,
  };
}

export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    content: "こんにちは",
    message_type: 0,
    content_type: "text",
    private: false,
    status: "sent",
    created_at: 1_789_000_000,
    sender: { id: 12, name: "山田 太郎", type: "contact" },
    attachments: [],
    ...overrides,
  };
}
