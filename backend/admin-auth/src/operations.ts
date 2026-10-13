import { createHash } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import type pg from "pg";
import { bootstrapAllowlist, ensureAllowlistTable } from "./allowlist.js";
import type { Auth } from "./auth.js";
import type { AlbConfig } from "./config.js";
import { OIDC_SCOPES } from "./constants.js";

// 1 回だけ実行する運用の処理（仕様 3.1）。開発の CLI（scripts/*.ts）と本番の運用の Lambda（ops.ts）で共有する

export interface MigrateResult {
  createdTables: string[];
  addedColumnsTables: string[];
  bootstrapped: number;
}

/**
 * Better Auth のスキーマ（ユーザー・セッション・OAuth クライアント・JWKS など）と許可リストの表を作り、
 * 最後に許可リストの初期値を追加する（起動時から移した。仕様 3.5）。何度実行しても安全
 */
export async function runMigrate(
  pool: pg.Pool,
  authOptions: Parameters<typeof getMigrations>[0],
  bootstrapEmails: string[],
  log: (line: string) => void = (line) => console.error(line),
): Promise<MigrateResult> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(authOptions);
  const createdTables = toBeCreated.map((t) => t.table);
  const addedColumnsTables = toBeAdded.map((t) => t.table);
  log(`[migrate] create tables: ${createdTables.join(", ") || "-"} / add columns: ${addedColumnsTables.join(", ") || "-"}`);
  await runMigrations();
  await ensureAllowlistTable(pool);
  const bootstrapped = await bootstrapAllowlist(pool, bootstrapEmails);
  log(`[migrate] allowlist bootstrap: ${bootstrapped} added`);
  return { createdTables, addedColumnsTables, bootstrapped };
}

export type AuthMethod = "client_secret_basic" | "client_secret_post";

export interface RegisterOptions {
  authMethod: AuthMethod;
  requirePkce: boolean;
}

export interface RegisterResult {
  outcome: "created" | "updated" | "unchanged";
  redirectUris: string[];
}

/**
 * ALB の authenticate-oidc を、信頼済みの機密クライアントとして登録（なければ作成、あれば同じ内容に更新）する。
 * 公開 API（adminCreateOAuthClient）はログイン済みのユーザーのセッションを要求し client_id も指定できないため、
 * Better Auth のアダプターで oauthClient の行を直接書く。plugin の版を上げたら、書く列とシークレットの保存方式を確かめる
 */
export async function registerAlbClient(auth: Pick<Auth, "$context">, alb: AlbConfig, options: RegisterOptions): Promise<RegisterResult> {
  const { adapter } = await auth.$context;
  const now = new Date();
  const redirectUris = alb.ALB_PROTECTED_HOSTS.map((host) => `https://${host}/oauth2/idpresponse`);
  const fields = {
    // plugin の既定（storeClientSecret: "hashed"）と同じ方式: SHA-256 の base64url（パディングなし）
    clientSecret: createHash("sha256").update(alb.ALB_CLIENT_SECRET).digest("base64url"),
    name: "ALB (admin gate)",
    redirectUris,
    scopes: OIDC_SCOPES,
    tokenEndpointAuthMethod: options.authMethod,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    applicationType: "web",
    // 自社の管理画面に、毎回「許可しますか」と聞かない
    skipConsent: true,
    enableEndSession: false,
    requirePKCE: options.requirePkce,
    disabled: false,
    clientCredentialsScopes: [],
    updatedAt: now,
  };

  const where = [{ field: "clientId", value: alb.ALB_CLIENT_ID }];
  const existing = await adapter.findOne<Record<string, unknown>>({ model: "oauthClient", where });
  // 同じ内容なら何も書かない（updatedAt も変えない）
  const { updatedAt: _updatedAt, ...desired } = fields;
  const unchanged =
    existing !== null && Object.entries(desired).every(([key, value]) => JSON.stringify(existing[key]) === JSON.stringify(value));
  if (unchanged) return { outcome: "unchanged", redirectUris };
  if (existing) {
    await adapter.update({ model: "oauthClient", where, update: fields });
    return { outcome: "updated", redirectUris };
  }
  await adapter.create({ model: "oauthClient", data: { clientId: alb.ALB_CLIENT_ID, clientDiscoveryId: null, createdAt: now, ...fields } });
  return { outcome: "created", redirectUris };
}
