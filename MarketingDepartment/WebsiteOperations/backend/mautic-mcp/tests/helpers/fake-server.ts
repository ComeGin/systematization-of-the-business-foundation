import type { McpServer } from "@modelcontextprotocol/server";
import { vi } from "vitest";

import type { MauticClient } from "../../src/services/mautic-client.js";

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
