import * as z from "zod/v4";

// 既定値のある変数は、空・空白だけなら未設定と同じに扱う（環境変数ファイルの空欄で起動が止まらないように）
const blankAsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const EnvSchema = z.object({
  HOST: z.preprocess(blankAsUnset, z.string().min(1).default("0.0.0.0")),
  PORT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(65_535).default(3104)),
  // 開発は redis://valkey:6379、本番（ElastiCache の TLS）は rediss://
  VALKEY_URL: z.string().regex(/^rediss?:\/\/.+/, "redis:// または rediss:// で始まる URL にしてください"),
  // AUTH トークン。空なら認証なし（開発のみ）
  VALKEY_PASSWORD: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  VALKEY_KEY_PREFIX: z.preprocess(blankAsUnset, z.string().min(1).max(64).default("consent:")),
  // CORS で許すオリジン。パスが付いていてもオリジンだけに正規化する
  SITE_URL: z
    // スキームは url() の protocol で検査する（refine は url() の失敗後も動き、中の new URL() が例外を投げるため使わない）
    .url({ protocol: /^https?$/, error: "http または https の URL にしてください" })
    .transform((value) => new URL(value).origin),
  // 空なら Domain 属性を付けない
  COOKIE_DOMAIN: z
    .string()
    .default("")
    .refine(
      (value) => value === "" || /^\.?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value),
      "ドメイン名の形式にしてください",
    ),
  // 記録と Cookie に入るため、Cookie に使える文字だけにする
  CONSENT_POLICY_VERSION: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,32}$/, "英数字と . _ - だけの 32 文字以内にしてください"),
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
