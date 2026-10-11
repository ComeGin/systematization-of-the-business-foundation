// Claude Agent SDK（@anthropic-ai/claude-agent-sdk の query）の差し替え。claude の子プロセス・Anthropic の API・MCP サーバーは起動しない。
// テストファイルの vi.mock から `() => import("./helpers/agent-sdk.js").then((m) => m.sdkModule)` の形で使う。
// query に渡された prompt と options（env・hooks・mcpServers など）を記録し、メッセージの列を台本どおりに返す。
import type { HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";

export interface QueryCall {
  prompt: string;
  options: Options;
}

export const sdk = {
  query: vi.fn<(args: QueryCall) => AsyncGenerator<unknown, void>>(),
};

export const sdkModule = { query: (args: QueryCall) => sdk.query(args) };

/** 台本の 1 手。メッセージを返すか、options を使って何かする（フックを呼ぶ・ゲートを待つ） */
export type Step = Record<string, unknown> | ((options: Options) => Promise<void>);

export const init = (overrides: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  permissionMode: "dontAsk",
  apiKeySource: "ANTHROPIC_API_KEY",
  tools: ["Read", "Write", "Glob"],
  mcp_servers: [],
  ...overrides,
});

export const result = (text: string, overrides: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  total_cost_usd: 0.12,
  ...overrides,
});

export const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "toolu_it", name, input }] },
});

/** ツールの結果（モデルに返る中身）。control-plane はこれを読まず、E-15 にも残さない */
export const toolResult = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_it", content: text }] },
});

/**
 * query() の代わり。中断されたら次を出さずに投げる（SDK と同じ）。
 * hang=true なら最後に中断を待つ。throwAfter があれば最後に投げる。
 */
export function script(steps: Step[], options: { hang?: boolean; throwAfter?: Error } = {}): void {
  sdk.query.mockImplementation(({ options: sdkOptions }) => {
    const signal = sdkOptions.abortController!.signal;
    return (async function* () {
      for (const step of steps) {
        if (signal.aborted) throw new Error("aborted");
        if (typeof step === "function") await step(sdkOptions);
        else yield step;
      }
      if (options.hang) {
        await new Promise((_, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (options.throwAfter) throw options.throwAfter;
    })();
  });
}

/** options.hooks.PreToolUse の 1 本目を、SDK がツールを呼ぶ前と同じ形で呼ぶ */
export async function callPreToolUse(sdkOptions: Options, toolName: string, toolInput: Record<string, unknown>): Promise<HookJSONOutput> {
  const hook = sdkOptions.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error("PreToolUse のフックが渡されていない");
  return hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: "toolu_it",
      session_id: "it-session",
      transcript_path: "",
      cwd: sdkOptions.cwd ?? "",
    } as never,
    "toolu_it",
    { signal: new AbortController().signal },
  );
}

export function resetSdk(): void {
  sdk.query.mockReset();
}

/** 最後の query の呼び出し */
export function lastQuery(): QueryCall {
  const call = sdk.query.mock.calls.at(-1);
  if (!call) throw new Error("query が呼ばれていない");
  return call[0];
}
