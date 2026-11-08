// 監視アプリの Agent の画面のための読み込み（設計 docs/superpowers/specs/2026-11-06-job-agent-info-design.md の 7 節）。
// 定義（.claude/agents/*.md）と登録表（ops/mcp-registry.yaml）は承認済み main のチェックアウトから読む（ADR-18）。
// ツールの「参照／書き込み」は表示のための目安で、権限の判定には使わない（権限は tools の許可リストと登録表の ACCESS_LEVEL が決める）。
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DEFINITIONS_DIR } from "../constants/paths.js";
import type { AgentInfo, AgentToolGroup, JobDefinition, ToolAccess } from "../contract.js";
import { AGENT_NAME_PATTERN, AgentDefinitionError, type AgentDefinition, loadAgentDefinition } from "./agent-def.js";
import type { McpRegistry } from "./registry.js";

const MCP_TOOL = /^mcp__([a-z][a-z0-9-]*)__(.+)$/;
const READ_VERBS = ["list", "get", "query", "search", "find", "inspect", "whoami", "estimate", "execute-sql"];
const WRITE_VERBS = ["create", "update", "add", "delete", "remove", "set", "send", "save", "run", "merge"];
const BUILTIN_READ = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
const BUILTIN_WRITE = new Set(["Write", "Edit", "NotebookEdit"]);
/** 接続先の名前から製品名を取り出すときに外す末尾（chatwoot-prod → chatwoot、mautic-prod-ro → mautic） */
const SERVER_SUFFIX = /-(?:prod|ro|dev)$/;

function productOf(server: string): string {
  let name = server;
  while (SERVER_SUFFIX.test(name)) name = name.replace(SERVER_SUFFIX, "");
  return name;
}

/** 動詞が先頭に来るか（次の文字は区切り〈_・-〉か終わり） */
function startsWithVerb(name: string, verbs: readonly string[]): boolean {
  return verbs.some((verb) => name === verb || name.startsWith(`${verb}_`) || name.startsWith(`${verb}-`));
}

export function classifyTool(tool: string, registry: McpRegistry): { server: string | null; access: ToolAccess } {
  const match = MCP_TOOL.exec(tool);
  if (!match) {
    if (BUILTIN_WRITE.has(tool)) return { server: null, access: "write" };
    if (BUILTIN_READ.has(tool)) return { server: null, access: "read" };
    return { server: null, access: "unknown" };
  }
  const server = match[1]!;
  if (registry.servers.get(server)?.access_level === "read_only") return { server, access: "read" };
  const prefix = `${productOf(server)}_`;
  const raw = match[2]!;
  const name = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (startsWithVerb(name, READ_VERBS)) return { server, access: "read" };
  if (startsWithVerb(name, WRITE_VERBS)) return { server, access: "write" };
  return { server, access: "unknown" };
}

export function buildAgentInfo(definition: AgentDefinition, jobs: JobDefinition[], registry: McpRegistry): AgentInfo {
  const builtin: AgentToolGroup = { server: null, accessLevel: null, tools: [] };
  const groups = new Map<string, AgentToolGroup>();
  for (const tool of definition.tools) {
    const { server, access } = classifyTool(tool, registry);
    if (server === null) {
      builtin.tools.push({ name: tool, access });
      continue;
    }
    let group = groups.get(server);
    if (!group) {
      group = { server, accessLevel: registry.servers.get(server)?.access_level ?? null, tools: [] };
      groups.set(server, group);
    }
    group.tools.push({ name: tool, access });
  }
  const mcpGroups = [...groups.values()].sort((a, b) => (a.server! < b.server! ? -1 : 1));
  return {
    name: definition.name,
    description: definition.description,
    model: definition.model,
    disallowedTools: definition.disallowedTools,
    body: definition.body,
    jobIds: jobs
      .filter((job) => job.kind === "agent" && job.agent === definition.name)
      .map((job) => job.id)
      .sort(),
    toolGroups: builtin.tools.length > 0 ? [builtin, ...mcpGroups] : mcpGroups,
  };
}

export async function listAgentDefinitions(
  mainCheckout: string,
): Promise<{ definitions: AgentDefinition[]; errors: { file: string; reason: string }[] }> {
  let files: string[];
  try {
    files = (await readdir(join(mainCheckout, AGENT_DEFINITIONS_DIR))).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { definitions: [], errors: [] };
    throw error;
  }
  const definitions: AgentDefinition[] = [];
  const errors: { file: string; reason: string }[] = [];
  for (const file of files) {
    const name = file.slice(0, -".md".length);
    if (!AGENT_NAME_PATTERN.test(name)) continue;
    try {
      definitions.push(await loadAgentDefinition(mainCheckout, name));
    } catch (error) {
      if (!(error instanceof AgentDefinitionError)) throw error;
      errors.push({ file, reason: error.message });
    }
  }
  return { definitions, errors };
}
