import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DEFINITIONS_DIR } from "../../src/constants/paths.js";
import type { JobDefinition } from "../../src/contract.js";
import { buildAgentInfo, classifyTool, listAgentDefinitions } from "../../src/definitions/agent-catalog.js";
import type { AgentDefinition } from "../../src/definitions/agent-def.js";
import type { McpRegistry, RegistryServer } from "../../src/definitions/registry.js";
import { makeTempDir, putFile } from "../helpers/store.js";

function registry(servers: { name: string; access_level?: string }[]): McpRegistry {
  return {
    servers: new Map(
      servers.map((server) => [
        server.name,
        { env: "prod", transport: "http", url: "https://example.invalid/mcp", args: [], ...server } as RegistryServer,
      ]),
    ),
  };
}

const REGISTRY = registry([
  { name: "chatwoot-prod", access_level: "read_write" },
  { name: "mautic-prod-ro", access_level: "read_only" },
  { name: "openseo" },
]);

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name: "conversation-triage", description: "役割。2 文目。", tools: [], disallowedTools: [], model: "sonnet", body: "本文", ...overrides };
}

function job(id: string, agent: string | null): JobDefinition {
  return {
    id,
    description: "",
    enabled: true,
    cron: "0 4 * * *",
    kind: agent ? "agent" : "builtin",
    agent,
    builtin: agent ? null : "heartbeat",
    after: [],
    timeoutSec: 600,
    maxTurns: null,
    prompt: agent ? "p" : null,
    overview: null,
    stage: null,
    io: null,
  };
}

describe("classifyTool", () => {
  describe("正常系", () => {
    it("chatwoot_add_private_note は接頭辞を取って write、chatwoot_list_conversations は read", () => {
      expect(classifyTool("mcp__chatwoot-prod__chatwoot_add_private_note", REGISTRY)).toEqual({ server: "chatwoot-prod", access: "write" });
      expect(classifyTool("mcp__chatwoot-prod__chatwoot_list_conversations", REGISTRY)).toEqual({ server: "chatwoot-prod", access: "read" });
      expect(classifyTool("mcp__chatwoot-prod__chatwoot_update_conversation", REGISTRY)).toEqual({ server: "chatwoot-prod", access: "write" });
    });

    it("read_only の接続先のツールは名前に関わらず read（mautic-prod-ro の mautic_run_report）", () => {
      expect(classifyTool("mcp__mautic-prod-ro__mautic_run_report", REGISTRY)).toEqual({ server: "mautic-prod-ro", access: "read" });
    });

    it("openseo の get_search_console_performance は read、research_keywords は unknown", () => {
      expect(classifyTool("mcp__openseo__get_search_console_performance", REGISTRY).access).toBe("read");
      expect(classifyTool("mcp__openseo__research_keywords", REGISTRY).access).toBe("unknown");
    });

    it("接頭辞の無い名前（strapi の create_content-plan・posthog の execute-sql）も先頭の語で分ける", () => {
      expect(classifyTool("mcp__strapi-prod__create_content-plan", REGISTRY)).toEqual({ server: "strapi-prod", access: "write" });
      expect(classifyTool("mcp__posthog-prod__execute-sql", REGISTRY)).toEqual({ server: "posthog-prod", access: "read" });
      expect(classifyTool("mcp__posthog-prod__query-error-tracking-issues-list", REGISTRY).access).toBe("read");
    });

    it("組み込みの Write・Edit は write、Read・Glob・Grep は read、ほかは unknown", () => {
      expect(classifyTool("Write", REGISTRY)).toEqual({ server: null, access: "write" });
      expect(classifyTool("Edit", REGISTRY).access).toBe("write");
      expect(classifyTool("Read", REGISTRY)).toEqual({ server: null, access: "read" });
      expect(classifyTool("Grep", REGISTRY).access).toBe("read");
      expect(classifyTool("Bash", REGISTRY).access).toBe("unknown");
    });
  });

  describe("異常系", () => {
    it("入力: 登録表に無い接続先は名前の規則だけで分ける", () => {
      expect(classifyTool("mcp__unknown-prod__unknown_delete_item", REGISTRY)).toEqual({ server: "unknown-prod", access: "write" });
    });

    it("空入力: 空のツール名は組み込みの unknown", () => {
      expect(classifyTool("", REGISTRY)).toEqual({ server: null, access: "unknown" });
    });
  });
});

describe("buildAgentInfo", () => {
  describe("正常系", () => {
    it("組み込みを先頭に接続先ごとにまとめ、accessLevel を付け、jobIds にその Agent のジョブだけを入れる", () => {
      const info = buildAgentInfo(
        definition({
          tools: ["mcp__openseo__whoami", "Read", "mcp__chatwoot-prod__chatwoot_add_private_note", "Write", "mcp__chatwoot-prod__chatwoot_list_messages"],
          disallowedTools: ["Bash"],
        }),
        [job("b-job", "conversation-triage"), job("a-job", "conversation-triage"), job("other", "seo-auditor"), job("hb", null)],
        REGISTRY,
      );
      expect(info).toEqual({
        name: "conversation-triage",
        description: "役割。2 文目。",
        model: "sonnet",
        disallowedTools: ["Bash"],
        body: "本文",
        jobIds: ["a-job", "b-job"],
        toolGroups: [
          { server: null, accessLevel: null, tools: [{ name: "Read", access: "read" }, { name: "Write", access: "write" }] },
          {
            server: "chatwoot-prod",
            accessLevel: "read_write",
            tools: [
              { name: "mcp__chatwoot-prod__chatwoot_add_private_note", access: "write" },
              { name: "mcp__chatwoot-prod__chatwoot_list_messages", access: "read" },
            ],
          },
          { server: "openseo", accessLevel: null, tools: [{ name: "mcp__openseo__whoami", access: "read" }] },
        ],
      });
    });

    it("空入力: tools が空なら toolGroups は []、使うジョブが無ければ jobIds は []", () => {
      const info = buildAgentInfo(definition(), [job("hb", null)], REGISTRY);
      expect(info.toolGroups).toEqual([]);
      expect(info.jobIds).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 登録表に無い接続先は accessLevel: null", () => {
      const info = buildAgentInfo(definition({ tools: ["mcp__ghost__ghost_list_x"] }), [], REGISTRY);
      expect(info.toolGroups).toEqual([{ server: "ghost", accessLevel: null, tools: [{ name: "mcp__ghost__ghost_list_x", access: "read" }] }]);
    });
  });
});

describe("listAgentDefinitions", () => {
  let temp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    temp = makeTempDir();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => temp.cleanup());

  const put = (file: string, text: string) => putFile(temp.dir, `${AGENT_DEFINITIONS_DIR}/${file}`, text);
  const agentMd = (name: string) => `---\nname: ${name}\ndescription: ${name} の役割\ntools: Read\n---\n\n本文\n`;

  describe("正常系", () => {
    it("名前の順に読む", async () => {
      put("seo-auditor.md", agentMd("seo-auditor"));
      put("analytics-reporter.md", agentMd("analytics-reporter"));
      const { definitions, errors } = await listAgentDefinitions(temp.dir);
      expect(errors).toEqual([]);
      expect(definitions.map((d) => d.name)).toEqual(["analytics-reporter", "seo-auditor"]);
    });

    it("空入力: .claude/agents が無ければ空", async () => {
      expect(await listAgentDefinitions(temp.dir)).toEqual({ definitions: [], errors: [] });
    });
  });

  describe("異常系", () => {
    it("入力: name がファイル名と違う定義を errors に入れ、ほかは返す", async () => {
      put("seo-auditor.md", agentMd("seo-auditor"));
      put("lead-ops.md", agentMd("other-name"));
      const { definitions, errors } = await listAgentDefinitions(temp.dir);
      expect(definitions.map((d) => d.name)).toEqual(["seo-auditor"]);
      expect(errors).toEqual([{ file: "lead-ops.md", reason: expect.stringContaining("name") }]);
    });

    it("入力: 名前の形でないファイル名と .md 以外は読まない", async () => {
      put("Bad_Name.md", agentMd("Bad_Name"));
      put("README.txt", "memo");
      expect(await listAgentDefinitions(temp.dir)).toEqual({ definitions: [], errors: [] });
    });
  });
});

describe("listAgentDefinitions（YAML の構文エラー）", () => {
  let temp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    temp = makeTempDir();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => temp.cleanup());

  describe("異常系", () => {
    it("入力: frontmatter の YAML が壊れた定義（キーの重複・閉じない括弧）は errors に入れ、ほかは返す", async () => {
      putFile(temp.dir, `${AGENT_DEFINITIONS_DIR}/seo-auditor.md`, "---\nname: seo-auditor\ndescription: 役割\ntools: Read\n---\n本文\n");
      putFile(temp.dir, `${AGENT_DEFINITIONS_DIR}/lead-ops.md`, "---\nname: lead-ops\nname: lead-ops\ntools: [Read\n---\n本文\n");
      const { definitions, errors } = await listAgentDefinitions(temp.dir);
      expect(definitions.map((d) => d.name)).toEqual(["seo-auditor"]);
      expect(errors).toEqual([{ file: "lead-ops.md", reason: "frontmatter を解釈できない: lead-ops" }]);
    });
  });
});
