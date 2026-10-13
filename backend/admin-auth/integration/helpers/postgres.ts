import { execFileSync } from "node:child_process";
import pg from "pg";

// 開発の PostgreSQL（compose のサービス postgres）。127.0.0.1:5434 にだけ開いている（compose.yml）
export const POSTGRES_CONTAINER = "admin-auth-postgres-1";

/**
 * 結合テスト専用のデータベース。開発の DB（admin_auth）は使わない（開発の JWKS の秘密鍵は開発の BETTER_AUTH_SECRET で
 * 暗号化されており、テストの状態が開発のデータに左右されるため）。global-setup が毎回作り直し、teardown で消す
 */
export const IT_DATABASE = "admin_auth_it";

/** コンテナの環境変数（POSTGRES_DB・POSTGRES_USER・POSTGRES_PASSWORD）。値は画面に出さない */
export function postgresEnv(name: "POSTGRES_DB" | "POSTGRES_USER" | "POSTGRES_PASSWORD"): string {
  return execFileSync("docker", ["exec", POSTGRES_CONTAINER, "printenv", name], { encoding: "utf8" }).trim();
}

/** 保守用の DB（postgres）につないで 1 文を流す。CREATE DATABASE・DROP DATABASE はトランザクションの外で流す必要がある */
async function admin(sql: string): Promise<void> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: 5434,
    database: "postgres",
    user: postgresEnv("POSTGRES_USER"),
    password: postgresEnv("POSTGRES_PASSWORD"),
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function recreateItDatabase(): Promise<void> {
  await admin(`DROP DATABASE IF EXISTS ${IT_DATABASE} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${IT_DATABASE}`);
}

export async function dropItDatabase(): Promise<void> {
  await admin(`DROP DATABASE IF EXISTS ${IT_DATABASE} WITH (FORCE)`);
}

export function pausePostgres(): void {
  execFileSync("docker", ["pause", POSTGRES_CONTAINER]);
}

/** 止めていなければ何もしない（afterEach から必ず呼ぶ） */
export function unpausePostgres(): void {
  const state = execFileSync("docker", ["inspect", "-f", "{{.State.Paused}}", POSTGRES_CONTAINER], { encoding: "utf8" }).trim();
  if (state === "true") execFileSync("docker", ["unpause", POSTGRES_CONTAINER]);
}
