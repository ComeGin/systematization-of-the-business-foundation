// エージェント定義（.claude/agents/<name>.md）の読み込み。承認済み main のチェックアウトから読む。
// frontmatter は Claude Code のサブエージェント形式だけ（name・description・tools・disallowedTools・model）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AGENT_DEFINITIONS_DIR } from "../constants/paths.js";

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface AgentDefinition {
  name: string;
  description: string;
  /** frontmatter の tools（組み込みと MCP の完全名が混在） */
  tools: string[];
  disallowedTools: string[];
  model: string | null;
  /** frontmatter を除いた本文（system prompt の追記に使う） */
  body: string;
}

export class AgentDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDefinitionError";
  }
}

function toList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    // 括弧の中のカンマで割らない（例: Bash(git log:*, git diff:*)）
    const items: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of value) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (char === "," && depth === 0) {
        items.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    items.push(current);
    return items.map((item) => item.trim()).filter(Boolean);
  }
  throw new AgentDefinitionError(`${field} は文字列か配列にしてください`);
}

export async function loadAgentDefinition(mainCheckout: string, agentName: string): Promise<AgentDefinition> {
  if (!AGENT_NAME_PATTERN.test(agentName)) throw new AgentDefinitionError("エージェント名が不正です");
  const file = join(mainCheckout, AGENT_DEFINITIONS_DIR, `${agentName}.md`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentDefinitionError(`エージェント定義が見つからない: ${agentName}`);
    }
    throw error;
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new AgentDefinitionError(`frontmatter が無い: ${agentName}`);
  const front = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
  if (!front || typeof front !== "object") throw new AgentDefinitionError(`frontmatter が不正: ${agentName}`);
  if (front.name !== agentName) throw new AgentDefinitionError(`frontmatter の name がファイル名と一致しない: ${agentName}`);

  return {
    name: agentName,
    description: typeof front.description === "string" ? front.description : "",
    tools: toList(front.tools, "tools"),
    disallowedTools: toList(front.disallowedTools, "disallowedTools"),
    model: typeof front.model === "string" && front.model.trim() ? front.model.trim() : null,
    body: (match[2] ?? "").trim(),
  };
}

const MCP_TOOL_PREFIX = /^mcp__([a-z][a-z0-9-]*)__/;

/** tools を、組み込みツールと、使う MCP サーバ名に分ける。 */
export function splitTools(tools: readonly string[]): { builtin: string[]; mcpServers: string[] } {
  const builtin: string[] = [];
  const servers = new Set<string>();
  for (const tool of tools) {
    const match = MCP_TOOL_PREFIX.exec(tool);
    if (match?.[1]) servers.add(match[1]);
    else if (!tool.startsWith("mcp__")) builtin.push(tool);
  }
  return { builtin, mcpServers: [...servers] };
}
