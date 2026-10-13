import * as z from "zod/v4";

const emailSchema = z.email();

const BaseSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3103),
  // 本番は https://auth.comegin.com、開発は http://localhost:3103。パスが付いていてもオリジンだけに正規化する
  BETTER_AUTH_URL: z
    // スキームは url() の protocol で検査する（refine は url() の失敗後も動き、中の new URL() が例外を投げるため使わない）
    .url({ protocol: /^https?$/, error: "http または https の URL にしてください" })
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

/** 設定が不正。メッセージは変数名と理由だけ（値は入れない） */
export class ConfigError extends Error {}

// 値そのもの（シークレット）は入れず、変数名と理由だけにする
const describeIssues = (error: z.ZodError): string =>
  `環境変数が不正です:\n${error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n")}`;

/** 開発の入口と CLI のための終了。ConfigError のときだけ、メッセージを出して exit(1) する */
function exitOnConfigError<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[config] ${error.message}`);
    process.exit(1);
  }
}

/**
 * 検証して返す。不正なら ConfigError を投げる（Lambda の入口が使う。プロセスを終了させない）。
 * requireGoogle: false なら、NODE_ENV=production でも Google の設定を求めない（運用の入口。移行と登録に Google は要らない）
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env, options: { requireGoogle?: boolean } = {}): Config {
  const result = (options.requireGoogle === false ? BaseSchema : EnvSchema).safeParse(env);
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  return result.data;
}

/** 開発の入口と CLI が使う。不正なら変数名と理由だけを stderr に出して終了する */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return exitOnConfigError(() => parseConfig(env));
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

/** ALB の設定を検証して返す。不正なら ConfigError を投げる（運用の入口が使う） */
export function parseAlbConfig(env: NodeJS.ProcessEnv = process.env): AlbConfig {
  const result = AlbSchema.safeParse(env);
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  return result.data;
}

export function loadAlbConfig(env: NodeJS.ProcessEnv = process.env): AlbConfig {
  return exitOnConfigError(() => parseAlbConfig(env));
}
