import * as z from "zod/v4";

const emailSchema = z.email();

const BaseSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3103),
  // 本番は https://auth.comegin.com、開発は http://localhost:3103。パスが付いていてもオリジンだけに正規化する
  BETTER_AUTH_URL: z
    .url()
    .refine((value) => /^https?:$/.test(new URL(value).protocol), "http または https の URL にしてください")
    .transform((value) => new URL(value).origin),
  // セッションと OAuth トークンの署名・暗号化に使う。変えると既存のセッションと暗号化済みの値が使えなくなる
  BETTER_AUTH_SECRET: z.string().min(32, "32 文字以上にしてください"),
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DATABASE_NAME: z.string().min(1).default("admin_auth"),
  DATABASE_USERNAME: z.string().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  // RDS では true（証明書を検証する。Docker イメージが RDS の CA を NODE_EXTRA_CA_CERTS で信頼させる）
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Google Cloud の OAuth クライアント（ユーザータイプは「内部」）。本番では必須
  GOOGLE_CLIENT_ID: z.string().optional().transform((value) => value || undefined),
  GOOGLE_CLIENT_SECRET: z.string().optional().transform((value) => value || undefined),
  // ID トークンの hd クレームと照合する Workspace のドメイン
  GOOGLE_HOSTED_DOMAIN: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "ドメイン名（小文字）にしてください")
    .default("comegin.com"),
  // 許可リストの初期値（カンマ区切り）。起動時に表へ追加するだけで、削除はしない
  ADMIN_BOOTSTRAP_EMAILS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    )
    .refine((emails) => emails.every((email) => emailSchema.safeParse(email).success), "メールアドレスの形式にしてください"),
});

const EnvSchema = BaseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
    if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "NODE_ENV=production では必須です" });
  }
});

export type Config = z.infer<typeof EnvSchema>;

function reportAndExit(error: z.ZodError): never {
  // 値そのもの（シークレット）は出力せず、変数名と理由だけを表示する
  const issues = error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  console.error(`[config] 環境変数が不正です:\n${issues.join("\n")}`);
  process.exit(1);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) reportAndExit(result.error);
  return result.data;
}

// ALB のクライアント登録スクリプトだけが使う設定
const AlbSchema = z.object({
  ALB_CLIENT_ID: z.string().min(8).regex(/^[A-Za-z0-9_-]+$/, "英数字と _ - だけにしてください"),
  ALB_CLIENT_SECRET: z.string().min(32, "32 文字以上にしてください"),
  // /oauth2/idpresponse を登録するホスト（カンマ区切り。ホスト名だけ）
  ALB_PROTECTED_HOSTS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    )
    .refine((hosts) => hosts.length > 0, "1 つ以上のホスト名が必要です")
    .refine(
      (hosts) => hosts.every((host) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)),
      "ホスト名だけを書いてください（スキームやパスは付けない）",
    ),
});

export type AlbConfig = z.infer<typeof AlbSchema>;

export function loadAlbConfig(env: NodeJS.ProcessEnv = process.env): AlbConfig {
  const result = AlbSchema.safeParse(env);
  if (!result.success) reportAndExit(result.error);
  return result.data;
}
