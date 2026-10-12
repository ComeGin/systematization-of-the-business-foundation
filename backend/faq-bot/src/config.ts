import * as z from "zod/v4";
import { DEFAULT_THRESHOLDS } from "./constants.js";

// 既定値のある変数は、空・空白だけなら未設定と同じに扱う（環境変数ファイルの空欄で起動が止まらないように）
const blankAsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

// スキームは url() の protocol で検査する（refine は url() の失敗後も動き、中の new URL() が例外を投げるため使わない）
const httpUrl = () => z.url({ protocol: /^https?$/, error: "http または https の URL にしてください" });
const ratio = (fallback: number) => z.preprocess(blankAsUnset, z.coerce.number().min(0).max(1).default(fallback));

const EnvSchema = z
  .object({
    HOST: z.preprocess(blankAsUnset, z.string().min(1).default("127.0.0.1")),
    PORT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(65_535).default(3107)),
    CHATWOOT_BASE_URL: httpUrl().transform((value) => value.replace(/\/+$/, "")),
    CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
    CHATWOOT_BOT_TOKEN: z.string().min(1),
    // Chatwoot の has_secure_token は 24 文字
    CHATWOOT_BOT_SECRET: z.string().min(16),
    FAQ_URL: httpUrl(),
    FAQ_REFRESH_SECONDS: z.preprocess(blankAsUnset, z.coerce.number().int().min(30).max(86_400).default(600)),
    FAQ_MATCH_HIGH: ratio(DEFAULT_THRESHOLDS.high),
    FAQ_MATCH_LOW: ratio(DEFAULT_THRESHOLDS.low),
    FAQ_MATCH_MARGIN: ratio(DEFAULT_THRESHOLDS.margin),
  })
  .refine((config) => config.FAQ_MATCH_LOW <= config.FAQ_MATCH_HIGH, {
    path: ["FAQ_MATCH_LOW"],
    message: "FAQ_MATCH_HIGH 以下にしてください",
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
