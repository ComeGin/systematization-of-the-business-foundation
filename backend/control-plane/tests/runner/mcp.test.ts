// buildMcpServers は SDK に渡す設定を組み立てるだけで、MCP サーバーには接続しない（子プロセスも起動しない）。
// 基準 D の例外: env ファイル・相対パスの解決というファイル操作そのものを確かめるため、os.tmpdir() の下の一時ディレクトリを使う。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRegistry, RegistryServer } from "../../src/definitions/registry.js";
import { McpSetupError, buildMcpServers } from "../../src/runner/mcp.js";
import { tempDir, writeAt } from "../helpers/runner.js";

let root: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir("cp-mcp-"));
});
afterEach(() => cleanup());

function registry(...servers: Partial<RegistryServer>[]): McpRegistry {
  return {
    servers: new Map(
      servers.map((server) => [
        server.name!,
        { env: "prod", transport: "stdio", args: [], ...server } as RegistryServer,
      ]),
    ),
  };
}

const build = (names: string[], reg: McpRegistry) =>
  buildMcpServers({ names, registry: reg, mainCheckout: join(root, "main"), realHome: join(root, "home") });

describe("buildMcpServers（stdio）", () => {
  describe("正常系", () => {
    it("${HOME} を実ホームで展開し、存在する相対パスだけ main のチェックアウトから解決する", async () => {
      writeAt(root, "main/backend/chatwoot-mcp/dist/index.js", "");
      const servers = await build(
        ["chatwoot-prod"],
        registry({
          name: "chatwoot-prod",
          command: "node",
          args: [
            "backend/chatwoot-mcp/dist/index.js",
            "--env-file-if-exists=${HOME}/.config/comegin/chatwoot-mcp.prod.env",
            "missing/dir/file.js",
            "stdio",
          ],
        }),
      );
      expect(servers["chatwoot-prod"]).toMatchObject({
        type: "stdio",
        command: "node",
        args: [
          join(root, "main/backend/chatwoot-mcp/dist/index.js"),
          `--env-file-if-exists=${join(root, "home")}/.config/comegin/chatwoot-mcp.prod.env`,
          "missing/dir/file.js",
          "stdio",
        ],
      });
    });

    it("子プロセスの env は HOME・PATH・env_vars だけで、control-plane の process.env を混ぜない", async () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_should_not_leak");
      vi.stubEnv("PATH", "/usr/bin:/bin");
      const servers = await build(
        ["mautic-prod"],
        registry({ name: "mautic-prod", command: "node", env_vars: { TRANSPORT: "stdio" } }),
      );
      expect((servers["mautic-prod"] as { env: Record<string, string> }).env).toEqual({
        HOME: join(root, "home"),
        PATH: "/usr/bin:/bin",
        TRANSPORT: "stdio",
      });
    });

    it("空入力: args が空・env_vars が無ければ args は空、env は HOME・PATH だけ", async () => {
      vi.stubEnv("PATH", "/usr/bin");
      const servers = await build(["x"], registry({ name: "x", command: "node" }));
      expect(servers.x).toEqual({ type: "stdio", command: "node", args: [], env: { HOME: join(root, "home"), PATH: "/usr/bin" } });
    });

    it("空入力: PATH が未設定なら env に PATH を入れない（空の PATH を作らない）", async () => {
      vi.stubEnv("PATH", undefined);
      const servers = await build(["x"], registry({ name: "x", command: "node" }));
      expect((servers.x as { env: Record<string, string> }).env).toEqual({ HOME: join(root, "home") });
    });
  });

  describe("異常系", () => {
    it("入力: 未定義の変数を使った args は McpSetupError（変数名だけを伝える）", async () => {
      const reg = registry({ name: "x", command: "node", args: ["${NOT_DEFINED}/a.js"] });
      await expect(build(["x"], reg)).rejects.toThrow(new McpSetupError("x.args: 変数 NOT_DEFINED が未定義"));
    });

    it("入力: process.env にある変数でも ${...} では展開しない（HOME だけ）", async () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_should_not_leak");
      const reg = registry({ name: "x", command: "node", args: ["--token=${GITHUB_TOKEN}"] });
      const error = (await build(["x"], reg).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(McpSetupError);
      expect(error.message).not.toContain("ghp_should_not_leak");
    });
  });
});

describe("buildMcpServers（http）", () => {
  describe("正常系", () => {
    it("headers_from_env_file の env ファイルを読んでヘッダーを作る", async () => {
      writeAt(root, "home/.config/comegin/openseo.env", "OPENSEO_TOKEN=abc123\n");
      const servers = await build(
        ["openseo"],
        registry({
          name: "openseo",
          transport: "http",
          url: "http://127.0.0.1:3001/mcp",
          headers_from_env_file: { env_file: "${HOME}/.config/comegin/openseo.env", Authorization: "Bearer ${OPENSEO_TOKEN}" },
        }),
      );
      expect(servers.openseo).toEqual({
        type: "http",
        url: "http://127.0.0.1:3001/mcp",
        headers: { Authorization: "Bearer abc123" },
      });
    });

    it("空入力: headers_from_env_file が無ければ headers を付けない", async () => {
      const servers = await build(["plain"], registry({ name: "plain", transport: "http", url: "http://127.0.0.1:3001/mcp" }));
      expect(servers.plain).toEqual({ type: "http", url: "http://127.0.0.1:3001/mcp" });
    });

    it("空入力: env_file だけでヘッダーのテンプレートが無ければ headers を付けない", async () => {
      writeAt(root, "home/x.env", "T=1\n");
      const servers = await build(
        ["plain"],
        registry({ name: "plain", transport: "http", url: "http://127.0.0.1:3001/mcp", headers_from_env_file: { env_file: "${HOME}/x.env" } }),
      );
      expect(servers.plain).toEqual({ type: "http", url: "http://127.0.0.1:3001/mcp" });
    });
  });

  describe("異常系", () => {
    it("入力: env ファイルを読めなければ McpSetupError（パスも値も出さない）", async () => {
      const reg = registry({
        name: "openseo",
        transport: "http",
        url: "http://127.0.0.1:3001/mcp",
        headers_from_env_file: { env_file: "${HOME}/missing.env", Authorization: "Bearer ${T}" },
      });
      const error = await build(["openseo"], reg).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpSetupError);
      expect((error as Error).message).toBe("openseo: env ファイルを読めない");
    });

    it("入力: env ファイルに変数が無ければ McpSetupError で、他の変数の値は出さない", async () => {
      writeAt(root, "home/x.env", "OTHER=very-secret-value\n");
      const reg = registry({
        name: "openseo",
        transport: "http",
        url: "http://127.0.0.1:3001/mcp",
        headers_from_env_file: { env_file: "${HOME}/x.env", Authorization: "Bearer ${OPENSEO_TOKEN}" },
      });
      const error = (await build(["openseo"], reg).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(McpSetupError);
      expect(error.message).toContain("OPENSEO_TOKEN");
      expect(error.message).not.toContain("very-secret-value");
    });

    it("空入力: env ファイルが空なら、使う変数が未定義として McpSetupError", async () => {
      writeAt(root, "home/empty.env", "");
      const reg = registry({
        name: "openseo",
        transport: "http",
        url: "http://127.0.0.1:3001/mcp",
        headers_from_env_file: { env_file: "${HOME}/empty.env", Authorization: "Bearer ${OPENSEO_TOKEN}" },
      });
      await expect(build(["openseo"], reg)).rejects.toThrow(new McpSetupError("openseo.headers.Authorization: 変数 OPENSEO_TOKEN が未定義"));
    });
  });
});

describe("buildMcpServers（共通）", () => {
  describe("正常系", () => {
    it("渡した名前の登録だけを組み立てる", async () => {
      const reg = registry({ name: "a", command: "node" }, { name: "b", command: "node" });
      expect(Object.keys(await build(["b"], reg))).toEqual(["b"]);
    });

    it("空入力: 名前が 0 件なら空のオブジェクト", async () => {
      const reg = registry({ name: "a", command: "node" });
      expect(await build([], reg)).toEqual({});
    });
  });

  describe("異常系", () => {
    it("入力: 登録表に無い名前は McpSetupError", async () => {
      await expect(build(["unknown"], registry())).rejects.toThrow(McpSetupError);
    });

    it("空入力: 登録表が空なら、どの名前も McpSetupError", async () => {
      await expect(build(["a"], registry())).rejects.toThrow(new McpSetupError("MCP の登録表に無い名前: a"));
    });
  });
});
