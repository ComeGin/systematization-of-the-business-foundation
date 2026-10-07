import * as z from "zod/v4";

/** .env.example のまま空にした変数（`MCP_AUTH_TOKEN=` など）は未設定として扱う */
const emptyAsUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const EnvSchema = z
  .object({
    CHATWOOT_BASE_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
    CHATWOOT_API_ACCESS_TOKEN: z.string().min(1),
    CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
    // 公開するツールの範囲: read_only（参照のみ）| read_write（作成・更新・送信も）| full（削除・統合も）
    CHATWOOT_ACCESS_LEVEL: z.enum(["read_only", "read_write", "full"]).default("read_only"),
    // 日時の表示と日付指定の解釈に使う UTC からの時差（時間）
    CHATWOOT_TIMEZONE_OFFSET: z.coerce.number().min(-12).max(14).default(9),
    TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3102),
    // MCP クライアント → 本サーバの認証に使う固定トークン（HTTP のときのみ必須）
    MCP_AUTH_TOKEN: z.preprocess(emptyAsUndefined, z.string().min(32, "32 文字以上にしてください").optional()),
    // ngrok などで公開する場合に許可するホスト名（カンマ区切り）。
    // 空（空白とカンマだけを含む）は未設定と同じにする（[] だと Host ヘッダーの検証がすべての要求を 403 にする）
    MCP_ALLOWED_HOSTS: z
      .string()
      .optional()
      .transform((value) => {
        const hosts = value?.split(",").map((host) => host.trim()).filter(Boolean);
        return hosts?.length ? hosts : undefined;
      }),
  })
  .refine((env) => env.TRANSPORT === "stdio" || env.MCP_AUTH_TOKEN, {
    message: "TRANSPORT=http の場合は必須です",
    path: ["MCP_AUTH_TOKEN"],
  });

export type Config = z.infer<typeof EnvSchema>;
export type AccessLevel = Config["CHATWOOT_ACCESS_LEVEL"];

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
