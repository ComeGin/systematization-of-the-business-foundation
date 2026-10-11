// Agent SDK（@anthropic-ai/claude-agent-sdk の query）は vi.mock で差し替え、実際の claude の子プロセス・API・MCP サーバーには繋がない。
// タイムアウトの時刻は偽物のタイマーで進める。エージェント定義・MCP の登録表の読み込みだけは一時ディレクトリの実ファイルを使う。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../src/context.js";
import type { AgentDefinition } from "../../src/definitions/agent-def.js";
import { type AgentRunInput, promptHeader, runAgent } from "../../src/runner/agent.js";
import { makeConfig, makeCtx, tempDir, writeAt } from "../helpers/runner.js";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const RUN_ID = "01K6PZ3T8Q4M2N7R9S5V1W3X6Y";
const STARTED_AT = "2026-10-04T06:00:00.123+09:00";

let root: string;
let cleanup: () => void;
let ctx: EngineContext;

const init = (overrides: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  permissionMode: "dontAsk",
  apiKeySource: "ANTHROPIC_API_KEY",
  tools: ["Read", "Write"],
  mcp_servers: [],
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "SUMMARY: 監査を書いた\nTARGET_IDS: AUD-2026-1004-gsc-0001",
  total_cost_usd: 0.42,
  ...overrides,
});

const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "t1", name, input }] },
});

/** 中断されたら次を出さずに投げる、SDK の query() の代わり。hang=true なら最後に中断を待つ。 */
function script(messages: unknown[], options: { throwAfter?: Error; hang?: boolean } = {}) {
  queryMock.mockImplementation(({ options: sdkOptions }: { options: Options }) => {
    const signal = sdkOptions.abortController!.signal;
    return (async function* () {
      for (const message of messages) {
        if (signal.aborted) throw new Error("aborted");
        yield message;
      }
      if (options.hang) {
        await new Promise((_, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      if (options.throwAfter) throw options.throwAfter;
    })();
  });
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "seo-auditor",
    description: "",
    tools: ["Read", "Write"],
    disallowedTools: ["WebFetch"],
    model: null,
    body: "エージェント定義の本文",
    ...overrides,
  };
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    ctx,
    runId: RUN_ID,
    startedAt: STARTED_AT,
    definition: definition(),
    prompt: "監査して",
    timeoutSec: 30,
    maxTurns: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const lastOptions = (): Options => (queryMock.mock.calls.at(-1)![0] as { options: Options }).options;
const lastPrompt = (): string => (queryMock.mock.calls.at(-1)![0] as { prompt: string }).prompt;

function writeRegistry(yaml: string) {
  writeAt(join(root, "main"), "MarketingDepartment/WebsiteOperations/ops/mcp-registry.yaml", yaml);
}

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-agent-"));
  ctx = makeCtx(
    makeConfig({
      mainCheckout: join(root, "main"),
      worktree: join(root, "wt"),
      dataDir: join(root, "data"),
      anthropic: { apiKey: "sk-ant-test" },
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => cleanup());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const logged = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");

describe("promptHeader", () => {
  describe("正常系", () => {
    it("CORRELATION_ID・NOW（秒精度）・TODAY の 3 行を startedAt から作る", () => {
      expect(promptHeader(RUN_ID, STARTED_AT)).toBe(
        `CORRELATION_ID: ${RUN_ID}\nNOW: 2026-10-04T06:00:00+09:00\nTODAY: 2026-10-04`,
      );
    });

    it("小数秒が無い startedAt はそのまま使う", () => {
      expect(promptHeader(RUN_ID, "2026-10-04T23:59:59+09:00")).toContain("NOW: 2026-10-04T23:59:59+09:00");
    });

    it("空入力: runId・startedAt が空文字でも 3 行の形は保つ（値は空）", () => {
      expect(promptHeader("", "")).toBe("CORRELATION_ID: \nNOW: \nTODAY: ");
    });
  });
});

describe("runAgent の起動前の検査（SDK を呼ばない）", () => {
  describe("正常系", () => {
    it("空入力: tools が空の定義でも起動し、tools・allowedTools・mcpServers は空", async () => {
      script([init({ tools: [] }), result()]);
      const outcome = await runAgent(input({ definition: definition({ tools: [], disallowedTools: [] }) }));
      expect(outcome.outcome).toBe("success");
      expect(lastOptions()).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, disallowedTools: ["Bash", "PowerShell"] });
    });
  });

  describe("異常系", () => {
    it("空入力: ANTHROPIC_API_KEY が無ければ例外", async () => {
      ctx = makeCtx(makeConfig({ anthropic: null }));
      await expect(runAgent(input())).rejects.toThrow("ANTHROPIC_API_KEY");
      expect(queryMock).not.toHaveBeenCalled();
    });

    it.each([["Bash"], ["Bash(git log:*)"], ["PowerShell"]])("入力: 定義に %s があれば起動しない", async (tool) => {
      const outcome = await runAgent(input({ definition: definition({ tools: ["Read", tool] }) }));
      expect(outcome).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("入力: MCP のツール名が不正なら起動しない", async () => {
      const outcome = await runAgent(input({ definition: definition({ tools: ["mcp__Bad_Name__x"] }) }));
      expect(outcome).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("入力: 登録表に無い MCP サーバを使う定義は起動しない", async () => {
      const outcome = await runAgent(input({ definition: definition({ tools: ["mcp__strapi-prod__get_article"] }) }));
      expect(outcome.outcome).toBe("failure");
      expect(outcome.failureClass).toBe("invalid_response");
      expect(outcome.summary).toContain("strapi-prod");
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("入力: 登録表（mcp-registry.yaml）が壊れていれば、SDK を呼ばずに例外を投げる（エンジンが failure にする）", async () => {
      writeRegistry("version: 2\nservers: []\n");
      await expect(runAgent(input())).rejects.toThrow(/mcp-registry.yaml が不正/);
      expect(queryMock).not.toHaveBeenCalled();
    });
  });
});

describe("runAgent が SDK に渡す安全設定", () => {
  beforeEach(() => script([init(), result()]));

  describe("正常系", () => {
    it("settingSources: []・dontAsk・strictMcpConfig・persistSession: false・cwd は作業ツリー", async () => {
      await runAgent(input());
      const options = lastOptions();
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe("dontAsk");
      expect(options.strictMcpConfig).toBe(true);
      expect(options.persistSession).toBe(false);
      expect(options.cwd).toBe(join(root, "wt"));
      expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "エージェント定義の本文" });
    });

    it("env は PATH・HOME・ANTHROPIC_API_KEY だけで、他の秘密値を渡さない", async () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws_secret");
      await runAgent(input());
      expect(lastOptions().env).toEqual({ PATH: process.env.PATH, HOME: homedir(), ANTHROPIC_API_KEY: "sk-ant-test" });
    });

    it("CONTROL_AGENT_HOME があれば HOME にそれを渡し、ディレクトリを作る", async () => {
      const agentHome = join(root, "agenthome");
      ctx = makeCtx({ ...ctx.config, agentHome });
      await runAgent(input());
      expect(lastOptions().env?.HOME).toBe(agentHome);
      expect(existsSync(agentHome)).toBe(true);
    });

    it("tools は組み込みだけ、allowedTools は定義どおり、disallowedTools に Bash 系を足す（重複させない）", async () => {
      writeRegistry("version: 1\nservers:\n  - name: chatwoot-prod\n    env: prod\n    transport: stdio\n    command: node\n");
      const tools = ["Read", "Write", "mcp__chatwoot-prod__chatwoot_get_conversation"];
      await runAgent(input({ definition: definition({ tools, disallowedTools: ["WebFetch", "Bash"] }) }));
      const options = lastOptions();
      expect(options.tools).toEqual(["Read", "Write"]);
      expect(options.allowedTools).toEqual(tools);
      expect(options.disallowedTools).toEqual(["WebFetch", "Bash", "PowerShell"]);
      expect(Object.keys(options.mcpServers ?? {})).toEqual(["chatwoot-prod"]);
    });

    it("maxTurns は指定が無ければ手動の既定（40）、model は定義にあるときだけ渡す", async () => {
      await runAgent(input());
      expect(lastOptions().maxTurns).toBe(40);
      expect(lastOptions()).not.toHaveProperty("model");
      await runAgent(input({ maxTurns: 7, definition: definition({ model: "sonnet" }) }));
      expect(lastOptions().maxTurns).toBe(7);
      expect(lastOptions().model).toBe("sonnet");
    });

    it("プロンプトの先頭に promptHeader を付ける", async () => {
      await runAgent(input());
      expect(lastPrompt()).toBe(`${promptHeader(RUN_ID, STARTED_AT)}\n\n監査して`);
    });

    it("空入力: プロンプトが空でも先頭の 3 行だけを付けて渡す（空の検査はエンジンと index が行う）", async () => {
      await runAgent(input({ prompt: "" }));
      expect(lastPrompt()).toBe(`${promptHeader(RUN_ID, STARTED_AT)}\n\n`);
    });

    it("PreToolUse フックで作業ツリーの秘匿ファイルへの書き込みを拒否する", async () => {
      await runAgent(input());
      const hook = lastOptions().hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
      const denied = await hook(
        { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, "wt/.env") } } as never,
        "t",
        { signal: new AbortController().signal },
      );
      expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      const allowed = await hook(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(root, "wt/a.md") } } as never,
        "t",
        { signal: new AbortController().signal },
      );
      expect(allowed).toEqual({});
    });
  });

  describe("異常系", () => {
    it("サーバ: 子プロセスの stderr は PII を伏せてからログに出す", async () => {
      await runAgent(input());
      lastOptions().stderr!("failed for taro@example.com");
      expect(logged()).toContain("[redacted:email]");
      expect(logged()).not.toContain("taro@example.com");
    });
  });
});

describe("runAgent の init の検査（違反なら打ち切る）", () => {
  describe("正常系", () => {
    it("空入力: init のツール・MCP の一覧が空なら打ち切らずに結果で判定する", async () => {
      script([init({ tools: [], mcp_servers: [] }), result()]);
      expect((await runAgent(input())).outcome).toBe("success");
      expect(lastOptions().abortController!.signal.aborted).toBe(false);
    });
  });

  describe("異常系", () => {
    it("サーバ: permissionMode が dontAsk でなければ invalid_response", async () => {
      script([init({ permissionMode: "bypassPermissions" }), result()]);
      const outcome = await runAgent(input());
      expect(outcome).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
      expect(lastOptions().abortController!.signal.aborted).toBe(true);
    });

    it("サーバ: apiKeySource が ANTHROPIC_API_KEY でなければ auth_failed（OAuth ログインで動かさない）", async () => {
      script([init({ apiKeySource: "none" }), result()]);
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass: "auth_failed" });
    });

    it("サーバ: 利用可能なツールに Bash 系があれば invalid_response", async () => {
      script([init({ tools: ["Read", "Bash"] }), result()]);
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
    });

    it("サーバ: MCP の接続が failed なら unreachable", async () => {
      script([init({ mcp_servers: [{ name: "chatwoot-prod", status: "failed" }, { name: "x", status: "connected" }] }), result()]);
      const outcome = await runAgent(input());
      expect(outcome).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
      expect(outcome.summary).toContain("chatwoot-prod");
      expect(outcome.summary).not.toContain("x,");
    });

    it("サーバ: 違反があれば、その後に success の結果が来ても failure にする", async () => {
      queryMock.mockImplementation(() =>
        (async function* () {
          yield init({ permissionMode: "default" });
          yield result();
        })(),
      );
      expect((await runAgent(input())).outcome).toBe("failure");
    });
  });
});

describe("runAgent の結果の分類", () => {
  describe("正常系", () => {
    it("success で SUMMARY があれば success。費用と subtype を残す", async () => {
      script([init(), result()]);
      expect(await runAgent(input())).toEqual({
        outcome: "success",
        summary: "監査を書いた",
        targetIds: ["AUD-2026-1004-gsc-0001"],
        sdkSubtype: "success",
        costUsd: 0.42,
      });
    });

    it("mcp__chatwoot の tool_use の conversation_id を targetIds に足す（他の MCP・整数でない値は見ない）", async () => {
      script([
        init(),
        toolUse("mcp__chatwoot-prod__chatwoot_get_conversation", { conversation_id: 12 }),
        toolUse("mcp__chatwoot-prod__chatwoot_add_private_note", { conversation_id: 12 }),
        toolUse("mcp__chatwoot-prod__chatwoot_list_messages", { conversation_id: "13" }),
        toolUse("mcp__chatwoot-prod__chatwoot_list_messages", { conversation_id: 1.5 }),
        toolUse("mcp__mautic-prod__mautic_get_contact", { conversation_id: 99 }),
        { type: "user", message: { content: [{ type: "tool_result", content: "conversation_id: 77" }] } },
        result(),
      ]);
      expect((await runAgent(input())).targetIds).toEqual(["AUD-2026-1004-gsc-0001", "chatwoot-conversation:12"]);
    });

    it("空入力: TARGET_IDS 行が無く tool_use も無ければ targetIds は空", async () => {
      script([init(), result({ result: "SUMMARY: 対象なし" })]);
      expect(await runAgent(input())).toMatchObject({ outcome: "success", summary: "対象なし", targetIds: [] });
    });
  });

  describe("異常系", () => {
    it("サーバ: success でも SUMMARY 行が無ければ partial（invalid_response）", async () => {
      script([init(), result({ result: "終わりました" })]);
      expect(await runAgent(input())).toMatchObject({ outcome: "partial", failureClass: "invalid_response" });
    });

    it("空入力: success の result が空文字なら partial（invalid_response）", async () => {
      script([init(), result({ result: "" })]);
      expect(await runAgent(input())).toMatchObject({ outcome: "partial", failureClass: "invalid_response", targetIds: [] });
    });

    it.each([
      [401, "auth_failed"],
      [403, "permission_denied"],
      [429, "rate_limited"],
      [500, "unreachable"],
      [529, "unreachable"],
      [null, "unreachable"],
      [400, "invalid_response"],
    ])("サーバ: is_error の success は api_error_status=%s を %s に分類する", async (status, failureClass) => {
      script([init(), result({ is_error: true, api_error_status: status })]);
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass });
    });

    it("サーバ: error_max_turns は partial（truncated）", async () => {
      script([init(), result({ subtype: "error_max_turns", result: undefined })]);
      expect(await runAgent(input())).toMatchObject({ outcome: "partial", failureClass: "truncated", sdkSubtype: "error_max_turns" });
    });

    it("サーバ: error_during_execution は failure（invalid_response）", async () => {
      script([init(), result({ subtype: "error_during_execution", result: undefined })]);
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
    });

    it("サーバ: 結果の後に query() が投げても、結果で判定する", async () => {
      script([init(), result()], { throwAfter: new Error("process exited") });
      expect((await runAgent(input())).outcome).toBe("success");
    });

    it("サーバ: 結果が無いまま例外なら unreachable、例外も無ければ invalid_response", async () => {
      script([init()], { throwAfter: new Error("spawn failed") });
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
      script([init()]);
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass: "invalid_response" });
    });

    it("空入力: query() が 1 件もメッセージを返さなければ invalid_response", async () => {
      script([]);
      expect(await runAgent(input())).toMatchObject({
        outcome: "failure",
        failureClass: "invalid_response",
        summary: "Agent SDK が結果を返さなかった",
      });
    });

    it("サーバ: query() の呼び出し自体が同期的に投げても unreachable にする（落ちない）", async () => {
      queryMock.mockImplementation(() => {
        throw new Error("claude executable not found");
      });
      expect(await runAgent(input())).toMatchObject({ outcome: "failure", failureClass: "unreachable" });
    });

    it("サーバ: SDK の例外のメッセージ（秘密値・個人情報が混ざりうる）はログに出さず、例外の名前だけを出す", async () => {
      script([init()], { throwAfter: new TypeError("401 for key sk-ant-leaked-value taro@example.com") });
      const outcome = await runAgent(input());
      expect(outcome.failureClass).toBe("unreachable");
      expect(logged()).toContain("Agent SDK の実行に失敗: TypeError");
      expect(logged()).not.toContain("sk-ant-leaked-value");
      expect(JSON.stringify(outcome)).not.toContain("sk-ant-leaked-value");
    });

    it("サーバ: エージェントの実行を再試行しない（query は 1 回だけ）", async () => {
      script([init()], { throwAfter: new Error("spawn failed") });
      await runAgent(input());
      expect(queryMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("runAgent の中断", () => {
  describe("正常系", () => {
    it("停止要求で中断したら timeout", async () => {
      script([init()], { hang: true });
      const stop = new AbortController();
      const running = runAgent(input({ signal: stop.signal }));
      await vi.waitFor(() => expect(queryMock).toHaveBeenCalled());
      stop.abort();
      expect(await running).toMatchObject({ outcome: "failure", failureClass: "timeout", summary: "停止要求で中断した" });
    });

    it("起動前に停止要求が出ていれば、最初のメッセージを待たずに中断する", async () => {
      script([init(), result()]);
      const stop = new AbortController();
      stop.abort();
      expect(await runAgent(input({ signal: stop.signal }))).toMatchObject({ outcome: "failure", failureClass: "timeout" });
    });
  });

  describe("異常系", () => {
    it("サーバ: 応答が timeout_sec を過ぎても返らなければ打ち切って timeout（時刻は偽物で進める）", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      script([init()], { hang: true });
      const running = runAgent(input({ timeoutSec: 30 }));
      // 登録表の読み込み（実ファイル）を待つ。setImmediate は偽物にしていないので時刻は進まない
      while (queryMock.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(lastOptions().abortController!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ outcome: "failure", failureClass: "timeout", summary: "タイムアウトで打ち切った" });
    });
  });
});
