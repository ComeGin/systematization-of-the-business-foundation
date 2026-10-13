import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as z from "zod/v4";
import { createAuth, createAuthOptions } from "./auth.js";
import { type AlbConfig, type Config, parseAlbConfig, parseConfig } from "./config.js";
import { createPool } from "./db.js";
import { registerAlbClient, runMigrate } from "./operations.js";
import { secretReader } from "./secrets.js";

// 運用の入口（admin-auth-ops。ALB にはつながない。運用者が aws lambda invoke で呼ぶ。仕様 2.3）。
// SAM の Handler は ops.handler（bundle が dist-lambda/ops.mjs を作る）
const EventSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("migrate") }),
  z.strictObject({
    action: z.literal("register-alb-client"),
    authMethod: z.enum(["client_secret_basic", "client_secret_post"]).default("client_secret_basic"),
    requirePkce: z.boolean().default(false),
  }),
]);

export interface OpsContext {
  config: Config;
  alb: AlbConfig;
}

export type OpsResult = { ok: true; action: "migrate" | "register-alb-client"; result: unknown } | { ok: false; error: string };

/** 秘密値を 3 つ読む（Google は読まない）。Google の設定は求めない（移行と登録に要らない。仕様 3.6） */
export async function loadOpsContext(env: NodeJS.ProcessEnv, readSecret: (name: string) => Promise<string>): Promise<OpsContext> {
  const [betterAuthSecret, dbPassword, albSecret] = await Promise.all([
    readSecret("BETTER_AUTH_SECRET"),
    readSecret("DB_PASSWORD"),
    readSecret("ALB_CLIENT_SECRET"),
  ]);
  const merged = { ...env, BETTER_AUTH_SECRET: betterAuthSecret, DATABASE_PASSWORD: dbPassword, ALB_CLIENT_SECRET: albSecret };
  return { config: parseConfig(merged, { requireGoogle: false }), alb: parseAlbConfig(merged) };
}

/**
 * 不正な入力は秘密値を読む前に { ok: false } を返す（値は入れない）。実行の失敗は例外（呼び出し元に FunctionError として見える）。
 * プールは呼び出しごとに作って閉じる（運用はまれなので使い回さない。移行は長くかかりうるので問い合わせのタイムアウトも付けない）
 */
export function createOpsHandler(load: () => Promise<OpsContext>, makePool: typeof createPool = createPool): (event: unknown) => Promise<OpsResult> {
  let ready: Promise<OpsContext> | null = null;
  return async (event) => {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      return { ok: false, error: `invalid event: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.code}`).join(", ")}` };
    }
    ready ??= load().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    const { config, alb } = await ready;
    const pool = makePool(config);
    try {
      if (parsed.data.action === "migrate") {
        const result = await runMigrate(pool, createAuthOptions(config, pool), config.ADMIN_BOOTSTRAP_EMAILS);
        console.error("[migrate] done");
        return { ok: true, action: "migrate", result };
      }
      const { authMethod, requirePkce } = parsed.data;
      const result = await registerAlbClient(createAuth(config, pool), alb, { authMethod, requirePkce });
      console.error(`[alb] ${result.outcome} client ${alb.ALB_CLIENT_ID}`);
      return { ok: true, action: "register-alb-client", result };
    } finally {
      await pool.end();
    }
  };
}

export const handler = createOpsHandler(() =>
  loadOpsContext(process.env, secretReader(new SecretsManagerClient({}), process.env.SECRETS_PREFIX ?? "")),
);
