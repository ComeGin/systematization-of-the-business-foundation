// Claude Agent SDK でエージェントを 1 回起動する（TA-07 の 3.3、ADR-18）。
//
// 安全設定（理由は README の表）:
//   settingSources: []        作業ツリーの未承認の設定・CLAUDE.md を実行に効かせない
//   permissionMode: dontAsk   allowedTools に無いものは確認なしで拒否（bypassPermissions は使わない）
//   tools / allowedTools      定義の tools だけ。Bash は与えない（含む定義は起動しない）
//   disallowedTools           定義の値 + Bash 系
//   env                       許可リスト（PATH・HOME・ANTHROPIC_API_KEY）で丸ごと置き換える
//   hooks.PreToolUse          ファイルツールを作業ツリーに閉じ込め、秘匿ファイルを拒否
//   strictMcpConfig           渡した mcpServers だけを使う
//   persistSession: false     SDK 自身の会話履歴（ツールの結果を含む）を ~/.claude に残さない
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { type Options, type SDKMessage, type SDKResultMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { EngineContext, RunResult } from "../context.js";
import type { FailureClass } from "../contract.js";
import { MANUAL_AGENT_DEFAULTS } from "../constants/timeouts.js";
import { type AgentDefinition, splitTools } from "../definitions/agent-def.js";
import { loadMcpRegistry } from "../definitions/registry.js";
import { logLine } from "../log.js";
import { redactSummary } from "../pii.js";
import { createPreToolUseGuard } from "./hooks.js";
import { McpSetupError, buildMcpServers } from "./mcp.js";
import { parseAgentOutput } from "./output.js";

const SHELL_TOOLS = ["Bash", "PowerShell"] as const;
const MCP_TOOL = /^mcp__[a-z][a-z0-9-]*__\S+$/;
const CONVERSATION_TARGET_PREFIX = "chatwoot-conversation:";
const MAX_TOOL_TARGETS = 200;

export interface AgentRunInput {
  ctx: EngineContext;
  runId: string;
  /** E-15 の startedAt と同じ値（ISO 8601、+09:00）。プロンプトの NOW・TODAY はここから作る（別に時刻を取らない） */
  startedAt: string;
  definition: AgentDefinition;
  prompt: string;
  timeoutSec: number;
  maxTurns: number | null;
  /** 停止要求（監視アプリの停止など）。 */
  signal: AbortSignal;
}

const failure = (summary: string, failureClass: FailureClass, extra: Partial<RunResult> = {}): RunResult => ({
  outcome: "failure",
  summary,
  targetIds: [],
  failureClass,
  ...extra,
});

function isShellTool(name: string): boolean {
  return SHELL_TOOLS.some((shell) => name === shell || name.startsWith(`${shell}(`));
}

function classifyApiStatus(status: number | null | undefined): FailureClass {
  if (status === 401) return "auth_failed";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limited";
  if (status === null || status === undefined || status >= 500) return "unreachable";
  return "invalid_response";
}

/** assistant の tool_use の引数から対象の ID を取り出す。結果は読まない（DD-07 の 4.1・8 節の推奨）。 */
function collectToolTargets(message: SDKMessage, into: Set<string>): void {
  if (message.type !== "assistant") return;
  const content = message.message.content as unknown as { type: string; name?: string; input?: Record<string, unknown> }[];
  for (const block of content) {
    if (block.type !== "tool_use" || !block.name?.startsWith("mcp__chatwoot")) continue;
    const id = block.input?.conversation_id;
    if (typeof id === "number" && Number.isInteger(id) && into.size < MAX_TOOL_TARGETS) {
      into.add(`${CONVERSATION_TARGET_PREFIX}${id}`);
    }
  }
}

/**
 * ユーザープロンプトの先頭 3 行（固定シート 10 節）。エージェントには Bash が無く現在時刻を知る手段が乏しいため、こちらから渡す。
 * NOW と TODAY は E-15 の startedAt と同じ時刻から、ここ 1 か所だけで作る。
 */
export function promptHeader(runId: string, startedAt: string): string {
  const now = startedAt.replace(/\.\d+(?=[+-]\d{2}:\d{2}$)/, ""); // 小数秒を落とす（秒精度）
  return [`CORRELATION_ID: ${runId}`, `NOW: ${now}`, `TODAY: ${startedAt.slice(0, 10)}`].join("\n");
}

export async function runAgent(input: AgentRunInput): Promise<RunResult> {
  const { ctx, runId, startedAt, definition, prompt, timeoutSec, signal } = input;
  const config = ctx.config;
  if (!config.anthropic) throw new Error("ANTHROPIC_API_KEY が無い");

  // --- 定義の検査（起動前。ここで落ちるものは SDK を呼ばない） ---
  if (definition.tools.some(isShellTool)) {
    return failure("エージェント定義に Bash 系のツールが含まれるため起動しなかった", "invalid_response");
  }
  const badMcp = definition.tools.filter((tool) => tool.startsWith("mcp__") && !MCP_TOOL.test(tool));
  if (badMcp.length > 0) {
    return failure("エージェント定義の MCP ツール名が不正のため起動しなかった", "invalid_response");
  }
  const { builtin, mcpServers: serverNames } = splitTools(definition.tools);

  const realHome = homedir();
  let mcpServers;
  try {
    const registry = await loadMcpRegistry(config.mainCheckout);
    mcpServers = await buildMcpServers({ names: serverNames, registry, mainCheckout: config.mainCheckout, realHome });
  } catch (error) {
    if (error instanceof McpSetupError) return failure(`MCP の設定が不正のため起動しなかった（${error.message}）`, "invalid_response");
    throw error;
  }

  const agentHome = config.agentHome;
  if (agentHome) mkdirSync(agentHome, { recursive: true, mode: 0o700 });

  // --- 中断（タイムアウト・停止要求） ---
  const abortController = new AbortController();
  let timedOut = false;
  let stopped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutSec * 1000);
  const onStop = () => {
    stopped = true;
    abortController.abort();
  };
  if (signal.aborted) onStop();
  else signal.addEventListener("abort", onStop, { once: true });

  // --- 実行中に見つけた異常（見つけたら打ち切る） ---
  let violation: string | null = null;
  let mcpFailed: string[] = [];
  const abortWith = (reason: string) => {
    violation ??= reason;
    abortController.abort();
  };

  const options: Options = {
    cwd: config.worktree,
    env: { PATH: process.env.PATH, HOME: agentHome ?? realHome, ANTHROPIC_API_KEY: config.anthropic.apiKey },
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    tools: builtin,
    allowedTools: definition.tools,
    disallowedTools: [...new Set([...definition.disallowedTools, ...SHELL_TOOLS])],
    mcpServers,
    systemPrompt: { type: "preset", preset: "claude_code", append: definition.body },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            createPreToolUseGuard(
              {
                worktree: config.worktree,
                dataDir: config.dataDir,
                mainCheckout: config.mainCheckout,
                realHome,
                agentHome,
              },
              (tool, reason) => logLine("WARN", "agent", `ツール呼び出しを拒否した: ${tool}: ${reason}`, runId),
            ),
          ],
        },
      ],
    },
    abortController,
    maxTurns: input.maxTurns ?? MANUAL_AGENT_DEFAULTS.maxTurns,
    persistSession: false,
    ...(definition.model ? { model: definition.model } : {}),
    stderr: (data) => logLine("INFO", "agent-stderr", redactSummary(data).text, runId),
  };

  const toolTargets = new Set<string>();
  let result: SDKResultMessage | null = null;
  let thrown = false;
  try {
    // 相関 ID は起動の直前に発行して先に E-15 に書いた値を、プロンプトの先頭行で渡す（DD-01 の 3.2）
    for await (const message of query({ prompt: `${promptHeader(runId, startedAt)}\n\n${prompt}`, options })) {
      if (message.type === "system" && message.subtype === "init") {
        mcpFailed = message.mcp_servers.filter((s) => s.status === "failed").map((s) => s.name);
        if (message.permissionMode !== "dontAsk") abortWith("権限モードが dontAsk になっていない");
        else if (message.apiKeySource !== "ANTHROPIC_API_KEY") abortWith("ANTHROPIC_API_KEY で認証されていない");
        else if (message.tools.some(isShellTool)) abortWith("Bash 系のツールが利用可能になっている");
        else if (mcpFailed.length > 0) abortWith(`MCP に接続できない: ${mcpFailed.join(", ")}`);
      } else if (message.type === "result") {
        result = message;
      } else {
        collectToolTargets(message, toolTargets);
      }
    }
  } catch (error) {
    // 単発の query() は、error の結果を返したあとにも throw する。結果があればそちらで判定する
    thrown = true;
    if (!result) logLine("ERROR", "agent", `Agent SDK の実行に失敗: ${error instanceof Error ? error.name : "unknown"}`, runId);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onStop);
  }

  const base = {
    sdkSubtype: result?.subtype ?? null,
    costUsd: result?.total_cost_usd ?? null,
  };

  if (violation) {
    const authProblem = (violation as string).includes("ANTHROPIC_API_KEY");
    const mcpProblem = mcpFailed.length > 0;
    return failure(`起動時の検査で打ち切った（${violation}）`, authProblem ? "auth_failed" : mcpProblem ? "unreachable" : "invalid_response", base);
  }
  if (timedOut) return failure("タイムアウトで打ち切った", "timeout", base);
  if (stopped) return failure("停止要求で中断した", "timeout", base);

  if (!result) return failure("Agent SDK が結果を返さなかった", thrown ? "unreachable" : "invalid_response", base);

  const targetIdsOf = (output: ReturnType<typeof parseAgentOutput>) => [...new Set([...output.targetIds, ...toolTargets])];

  if (result.subtype === "success") {
    const output = parseAgentOutput(result.result);
    if (result.is_error) {
      return failure("エージェントの最後の API 呼び出しが失敗した", classifyApiStatus(result.api_error_status), {
        ...base,
        targetIds: targetIdsOf(output),
      });
    }
    if (!output.summary) {
      return {
        outcome: "partial",
        summary: "エージェントは終了したが SUMMARY 行が無かった",
        targetIds: targetIdsOf(output),
        failureClass: "invalid_response",
        ...base,
      };
    }
    return { outcome: "success", summary: output.summary, targetIds: targetIdsOf(output), ...base };
  }
  if (result.subtype === "error_max_turns") {
    return {
      outcome: "partial",
      summary: "最大ターン数に達して打ち切られた",
      targetIds: [...toolTargets],
      failureClass: "truncated",
      ...base,
    };
  }
  return failure(`エージェントの実行がエラーで終了した（${result.subtype}）`, "invalid_response", {
    ...base,
    targetIds: [...toolTargets],
  });
}
