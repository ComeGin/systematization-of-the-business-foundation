import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DEFINITIONS_DIR } from "../../src/constants/paths.js";
import { AgentDefinitionError, loadAgentDefinition, splitTools } from "../../src/definitions/agent-def.js";
import { loadMcpRegistry } from "../../src/definitions/registry.js";
import { makeTempDir, putFile, repositoryRoot } from "../helpers/store.js";

let temp: ReturnType<typeof makeTempDir>;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

function putAgent(name: string, content: string): void {
  putFile(temp.dir, join(AGENT_DEFINITIONS_DIR, `${name}.md`), content);
}

describe("loadAgentDefinition", () => {
  describe("正常系", () => {
    it("frontmatter と本文を読み、tools のカンマは括弧の中では割らない", async () => {
      putAgent(
        "seo-auditor",
        [
          "---",
          "name: seo-auditor",
          "description: 観測エージェント",
          "tools: Read, Bash(git log:*, git diff:*), mcp__openseo__whoami",
          "disallowedTools: Write",
          "model: ' sonnet '",
          "---",
          "",
          "  本文の 1 行目",
          "",
        ].join("\n"),
      );
      expect(await loadAgentDefinition(temp.dir, "seo-auditor")).toEqual({
        name: "seo-auditor",
        description: "観測エージェント",
        tools: ["Read", "Bash(git log:*, git diff:*)", "mcp__openseo__whoami"],
        disallowedTools: ["Write"],
        model: "sonnet",
        body: "本文の 1 行目",
      });
    });

    it("tools は YAML の配列でもよく、無ければ空。model が無ければ null", async () => {
      putAgent("a", "---\nname: a\ntools:\n  - Read\n  - ' Grep '\n---\nbody");
      const def = await loadAgentDefinition(temp.dir, "a");
      expect(def.tools).toEqual(["Read", "Grep"]);
      expect(def.disallowedTools).toEqual([]);
      expect(def.model).toBeNull();
      expect(def.description).toBe("");
    });

    it("CRLF の改行でも読める", async () => {
      putAgent("crlf", "---\r\nname: crlf\r\ntools: Read\r\n---\r\n本文\r\n");
      const def = await loadAgentDefinition(temp.dir, "crlf");
      expect(def.tools).toEqual(["Read"]);
      expect(def.body).toBe("本文");
    });

    it("空入力: tools・disallowedTools が空文字・空配列、model が空白だけ、本文が空なら、空の一覧・null・空文字", async () => {
      putAgent("empty-fields", "---\nname: empty-fields\ntools: ''\ndisallowedTools: []\nmodel: '  '\n---\n");
      expect(await loadAgentDefinition(temp.dir, "empty-fields")).toEqual({
        name: "empty-fields",
        description: "",
        tools: [],
        disallowedTools: [],
        model: null,
        body: "",
      });
    });

    it("tools の空の要素（連続したカンマ・末尾のカンマ）は捨てる", async () => {
      putAgent("commas", "---\nname: commas\ntools: 'Read,, Grep ,'\n---\n");
      expect((await loadAgentDefinition(temp.dir, "commas")).tools).toEqual(["Read", "Grep"]);
    });
  });

  describe("異常系", () => {
    it.each(["../escape", "Upper", "a_b", "a--b", "-a", "a/b"])(
      "入力: エージェント名 %j はファイルを読む前に拒否する（パスの外へ出さない）",
      async (name) => {
        await expect(loadAgentDefinition(temp.dir, name)).rejects.toThrow(AgentDefinitionError);
      },
    );

    it("空入力: エージェント名が空文字なら、ファイルを読む前に拒否する", async () => {
      await expect(loadAgentDefinition(temp.dir, "")).rejects.toThrow(AgentDefinitionError);
    });

    it("入力: 定義が無ければ AgentDefinitionError（見つからない）", async () => {
      await expect(loadAgentDefinition(temp.dir, "missing")).rejects.toThrow(/見つからない: missing/);
    });

    it("空入力: 定義のファイルが空なら frontmatter が無いとして拒否する", async () => {
      putAgent("empty", "");
      await expect(loadAgentDefinition(temp.dir, "empty")).rejects.toThrow(/frontmatter が無い: empty/);
    });

    it("空入力: frontmatter の中身が空なら不正として拒否する", async () => {
      putAgent("blank", "---\n\n---\n本文");
      await expect(loadAgentDefinition(temp.dir, "blank")).rejects.toThrow(/frontmatter が不正: blank/);
    });

    it("入力: frontmatter が無ければ拒否する", async () => {
      putAgent("plain", "name: plain\n本文だけ");
      await expect(loadAgentDefinition(temp.dir, "plain")).rejects.toThrow(/frontmatter が無い/);
    });

    it("入力: frontmatter がオブジェクトでなければ拒否する", async () => {
      putAgent("scalar", "---\njust a string\n---\n");
      await expect(loadAgentDefinition(temp.dir, "scalar")).rejects.toThrow(/frontmatter が不正/);
    });

    it("入力: frontmatter の name がファイル名と違えば拒否する（別の定義のなりすましを防ぐ）", async () => {
      putAgent("lead-ops", "---\nname: proposal-writer\n---\n");
      await expect(loadAgentDefinition(temp.dir, "lead-ops")).rejects.toThrow(/一致しない/);
    });

    it("入力: tools が文字列でも配列でもなければ拒否する", async () => {
      putAgent("bad", "---\nname: bad\ntools: 3\n---\n");
      await expect(loadAgentDefinition(temp.dir, "bad")).rejects.toThrow(/tools は文字列か配列/);
    });

    it("入力: disallowedTools がオブジェクトなら拒否する", async () => {
      putAgent("bad-dis", "---\nname: bad-dis\ndisallowedTools:\n  Write: true\n---\n");
      await expect(loadAgentDefinition(temp.dir, "bad-dis")).rejects.toThrow(/disallowedTools は文字列か配列/);
    });

    it("入力: 定義のパスがファイルでなければ（EISDIR）、見つからないとは言わずにそのまま投げる", async () => {
      mkdirSync(join(temp.dir, AGENT_DEFINITIONS_DIR, "dir-agent.md"), { recursive: true });
      const error = (await loadAgentDefinition(temp.dir, "dir-agent").catch((e: unknown) => e)) as NodeJS.ErrnoException;
      expect(error).not.toBeInstanceOf(AgentDefinitionError);
      expect(error.code).toBe("EISDIR");
    });
  });
});

describe("splitTools", () => {
  describe("正常系", () => {
    it("組み込みツールと MCP サーバ名（重複なし）に分ける", () => {
      expect(
        splitTools(["Read", "mcp__strapi-prod__list_article", "mcp__strapi-prod__get_article", "mcp__openseo__whoami", "Write"]),
      ).toEqual({ builtin: ["Read", "Write"], mcpServers: ["strapi-prod", "openseo"] });
    });

    it("空入力: 空の一覧なら、どちらも空", () => {
      expect(splitTools([])).toEqual({ builtin: [], mcpServers: [] });
    });
  });

  describe("異常系", () => {
    it("入力: 形の崩れた mcp__ の名前は、組み込みにもサーバにも入れない", () => {
      expect(splitTools(["mcp__Bad__tool", "mcp__", "mcp__x"])).toEqual({ builtin: [], mcpServers: [] });
    });
  });
});

describe("実在のエージェント定義（リポジトリ直下の .claude/agents）", () => {
  const root = repositoryRoot();

  describe("正常系", () => {
    it.skipIf(!root)("すべて読み込めて、使う MCP サーバはすべて登録表にある", async () => {
      const names = readdirSync(join(root!, AGENT_DEFINITIONS_DIR))
        .filter((file) => file.endsWith(".md"))
        .map((file) => file.slice(0, -3));
      expect(names.length).toBeGreaterThan(0);
      const registry = await loadMcpRegistry(root!);
      for (const name of names) {
        const def = await loadAgentDefinition(root!, name);
        const missing = splitTools(def.tools).mcpServers.filter((server) => !registry.servers.has(server));
        expect({ name, missing }).toEqual({ name, missing: [] });
      }
    });
  });
});
