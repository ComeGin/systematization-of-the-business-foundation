import * as z from "zod/v4";

const EnvSchema = z
  .object({
    MAUTIC_BASE_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
    MAUTIC_CLIENT_ID: z.string().min(1),
    MAUTIC_CLIENT_SECRET: z.string().min(1),
    // 公開するツールの範囲: read_only（参照のみ）| read_write（作成・更新も）| full（削除も）
    MAUTIC_ACCESS_LEVEL: z.enum(["read_only", "read_write", "full"]).default("read_only"),
    TRANSPORT: z.enum(["http", "stdio"]).default("http"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    // MCP クライアント → 本サーバの認証に使う固定トークン（HTTP のときのみ必須）
    MCP_AUTH_TOKEN: z.string().min(32, "32 文字以上にしてください").optional(),
    // ngrok などで公開する場合に許可するホスト名（カンマ区切り）
    MCP_ALLOWED_HOSTS: z
      .string()
      .optional()
      .transform((value) => value?.split(",").map((host) => host.trim()).filter(Boolean)),
  })
  .refine((env) => env.TRANSPORT === "stdio" || env.MCP_AUTH_TOKEN, {
    message: "TRANSPORT=http の場合は必須です",
    path: ["MCP_AUTH_TOKEN"],
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    // 値そのもの（シークレット）は出力せず、変数名と理由だけを表示する
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    console.error(`[config] 環境変数が不正です:\n${issues.join("\n")}`);
    process.exit(1);
  }
  return result.data;
}
