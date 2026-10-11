// 実行ごとに、そのエージェントの tools に出てくる MCP の登録だけを登録表から組み立てて SDK に渡す。
// 秘密値の扱い:
//   - stdio: `--env-file-if-exists=<パス>` を args に入れるだけ。値は MCP サーバの子プロセスが自分で読む。
//   - http: headers_from_env_file の env ファイルを control-plane が読み、ヘッダーを作る。
//           エージェントのファイルツールは作業ツリーの外（~/.config/comegin）を読めない（hooks.ts）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpRegistry, RegistryServer } from "../definitions/registry.js";

/** 起動前に分かる設定の誤り。メッセージには登録名・変数名だけを入れ、値は入れない。 */
export class McpSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSetupError";
  }
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expand(template: string, vars: Record<string, string | undefined>, where: string): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new McpSetupError(`${where}: 変数 ${name} が未定義`);
    return value;
  });
}

function stdioConfig(server: RegistryServer, mainCheckout: string, realHome: string): McpServerConfig {
  const vars = { HOME: realHome };
  const args = server.args.map((raw) => {
    const arg = expand(raw, vars, `${server.name}.args`);
    // 相対パスは CONTROL_MAIN_CHECKOUT から解決する（存在するものだけ。オプションや単語はそのまま）
    if (!arg.startsWith("-") && !isAbsolute(arg) && arg.includes("/")) {
      const candidate = resolve(mainCheckout, arg);
      if (existsSync(candidate)) return candidate;
    }
    return arg;
  });
  // 子プロセスの env は、control-plane の process.env を混ぜない。PATH（node を探すため）と実ホーム（${HOME} の展開と同じ）に、
  // 登録表の env_vars（秘密でない定数だけ。例 TRANSPORT=stdio）を足す。秘密値は --env-file-if-exists で子プロセスが自分で読む。
  // SDK がこの env を既存の環境に足すのか置き換えるのかは確かめていない（どちらでも動くよう PATH と HOME を明示する）。
  const env: Record<string, string> = { HOME: realHome, ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...server.env_vars };
  return { type: "stdio", command: server.command!, args, env };
}

async function httpConfig(server: RegistryServer, realHome: string): Promise<McpServerConfig> {
  const spec = server.headers_from_env_file;
  const headers: Record<string, string> = {};
  if (spec) {
    const { env_file: envFile, ...templates } = spec;
    const file = expand(envFile, { HOME: realHome }, `${server.name}.headers_from_env_file.env_file`);
    let vars: Record<string, string | undefined>;
    try {
      vars = parseEnv(await readFile(file, "utf8"));
    } catch {
      throw new McpSetupError(`${server.name}: env ファイルを読めない`);
    }
    for (const [header, template] of Object.entries(templates)) {
      headers[header] = expand(template, vars, `${server.name}.headers.${header}`);
    }
  }
  return { type: "http", url: server.url!, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
}

export async function buildMcpServers(args: {
  names: readonly string[];
  registry: McpRegistry;
  mainCheckout: string;
  realHome: string;
}): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};
  for (const name of args.names) {
    const server = args.registry.servers.get(name);
    if (!server) throw new McpSetupError(`MCP の登録表に無い名前: ${name}`);
    servers[name] =
      server.transport === "stdio"
        ? stdioConfig(server, args.mainCheckout, args.realHome)
        : await httpConfig(server, args.realHome);
  }
  return servers;
}
