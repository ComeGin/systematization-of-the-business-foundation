import type { McpServer } from "@modelcontextprotocol/server";
import { vi } from "vitest";

import { MauticApiError, MauticNetworkError, type MauticClient } from "../../src/services/mautic-client.js";

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: { parse: (input: unknown) => unknown };
  outputSchema?: unknown;
  annotations?: Record<string, boolean>;
};
type ToolHandler = (args: unknown, ctx: unknown) => Promise<ToolResult>;

export interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * registerTool の呼び出しだけを記録する McpServer の代わり。
 * call() は SDK と同じく inputSchema で引数を検証し（既定値の補完を含む）、ハンドラーを呼ぶ
 */
export function createFakeServer() {
  const tools = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const server = {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      if (tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      tools.set(name, { config, handler });
    },
  };

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool ${name} is not registered`);
    const parsed = tool.config.inputSchema ? tool.config.inputSchema.parse(args) : args;
    return tool.handler(parsed, {});
  }

  return { server: server as unknown as McpServer, tools, call };
}

/** MauticClient の公開メソッドを vi.fn() にした偽物 */
export function createFakeClient() {
  const mocks = { get: vi.fn(), getList: vi.fn(), write: vi.fn() };
  return { client: mocks as unknown as MauticClient, ...mocks };
}

/**
 * ツールのテストで共通に使う、上流（Mautic）側の異常。MauticClient が投げうる例外と、モデルに返す文面の一部の組。
 * [説明, 投げる例外, 結果のテキストに含まれるべき文字列]
 */
export const SERVER_ERRORS: [label: string, error: unknown, expected: string][] = [
  ["トークン取得の失敗（認証情報の誤り）", new MauticApiError(401, "Failed to obtain Mautic access token: invalid_client"), "cannot be fixed by retrying"],
  ["再取得後も 401", new MauticApiError(401, "expired"), "rejected the access token even after refreshing it"],
  ["403", new MauticApiError(403, "no access"), "Permission denied (no access)"],
  ["429", new MauticApiError(429, "slow down"), "Rate limit exceeded"],
  ["5xx", new MauticApiError(503, "SQLSTATE[HY000]"), "Mautic server error (503)"],
  ["通信失敗（fetch の reject）", new MauticNetworkError(new TypeError("fetch failed")), "Could not reach Mautic (network error)"],
  ["想定外の形の応答（整形中の TypeError）", new TypeError("Cannot read properties of undefined (reading 'id')"), "Unexpected response shape from Mautic"],
  ["タイムアウト", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "did not respond within 30s"],
  ["JSON でない応答", new SyntaxError("Unexpected token '<'"), "non-JSON response"],
];
