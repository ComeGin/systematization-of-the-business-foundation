// MCP の登録表（ops/mcp-registry.yaml）の読み込み。形式は固定シート 5 節。
// 秘密値は書かれていない。env ファイルのパスと変数名だけを持つ。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";
import { MCP_REGISTRY_FILE } from "../constants/paths.js";

/** 秘密値を登録表に書かせないため、キー名がこれに合う env は拒否する（秘密値は env ファイルに置く） */
const SECRET_KEY_NAME = /secret|password|token|api_?key|hmac|key$/i;

const ServerSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case にしてください（__ を含めない）"),
    env: z.enum(["dev", "prod"]),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.url().optional(),
    access_level: z.string().optional(),
    // stdio の MCP サーバーの子プロセスに渡す環境変数。秘密でない定数だけ（例: TRANSPORT: stdio）。
    // 登録表の `env`（dev | prod）と名前が重なるため、キー名は env_vars
    env_vars: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "環境変数名にしてください"), z.string())
      .superRefine((vars, ctx) => {
        for (const key of Object.keys(vars)) {
          if (SECRET_KEY_NAME.test(key)) {
            ctx.addIssue({ code: "custom", message: `${key}: 秘密値は登録表に書かない（env ファイルに置く）`, path: [key] });
          }
        }
      })
      .optional(),
    // env_file のパスと、ヘッダー名 → 値のテンプレート（"Bearer ${VAR}"）。値そのものは書かない
    headers_from_env_file: z.object({ env_file: z.string().min(1) }).catchall(z.string()).optional(),
  })
  .superRefine((server, ctx) => {
    if (server.transport === "stdio" && !server.command) {
      ctx.addIssue({ code: "custom", message: "transport=stdio では必須です", path: ["command"] });
    }
    if (server.transport === "http" && server.env_vars) {
      ctx.addIssue({ code: "custom", message: "env_vars は transport=stdio のときだけ使える", path: ["env_vars"] });
    }
    if (server.transport === "http" && !server.url) {
      ctx.addIssue({ code: "custom", message: "transport=http では必須です", path: ["url"] });
    }
  });

const RegistrySchema = z.object({
  version: z.literal(1),
  servers: z.array(ServerSchema),
});

export type RegistryServer = z.infer<typeof ServerSchema>;

export interface McpRegistry {
  servers: Map<string, RegistryServer>;
}

export async function loadMcpRegistry(mainCheckout: string): Promise<McpRegistry> {
  const file = join(mainCheckout, MCP_REGISTRY_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: new Map() };
    throw error;
  }
  const parsed = RegistrySchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`mcp-registry.yaml が不正です: ${reason}`);
  }
  const servers = new Map<string, RegistryServer>();
  for (const server of parsed.data.servers) {
    if (servers.has(server.name)) throw new Error(`mcp-registry.yaml: 名前が重複しています: ${server.name}`);
    servers.set(server.name, server);
  }
  return { servers };
}
