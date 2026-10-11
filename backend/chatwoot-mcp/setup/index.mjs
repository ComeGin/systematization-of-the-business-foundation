// chatwoot-mcp（自作 MCP サーバ）の設定。依存の導入 → ビルド → ~/.config/comegin/mcp/chatwoot-dev.env の作成。
// 出典: backend/chatwoot-mcp/src/config.ts（変数名）、ops/mcp-registry.yaml（env ファイルのパスと env_vars）、
//       backend/chatwoot-mcp/src/tools/account.ts（GET /api/v1/profile で api_access_token を確かめている）。
// TRANSPORT と CHATWOOT_ACCESS_LEVEL は登録表の env_vars が渡す（env ファイルに書くと上書きの余地が生まれるので書かない）。
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "chatwoot-mcp", title: "Chatwoot の MCP サーバ（ビルドと env ファイル）", targets: ["dev"], after: ["chatwoot"] };

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const KEYS = ["CHATWOOT_BASE_URL", "CHATWOOT_API_ACCESS_TOKEN", "CHATWOOT_ACCOUNT_ID"];

const dirOf = (ctx) => join(ctx.W, "backend/chatwoot-mcp");
const envPathOf = (ctx) => join(ctx.CONFIG_DIR, "mcp", "chatwoot-dev.env");

async function ensureTooling(ctx) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node ${process.versions.node} は古い。chatwoot-mcp は Node 22.18 以上が要る`);
  let v;
  try {
    v = (await ctx.run("pnpm", ["--version"])).trim();
  } catch {
    throw new Error("pnpm が使えない。pnpm 11 以上を入れる（corepack enable && corepack prepare pnpm@latest --activate など）");
  }
  // pnpm-workspace.yaml の minimumReleaseAge などは pnpm 11 未満では効かない（黙って無効になる）
  if (Number(v.split(".")[0]) < 11) throw new Error(`pnpm ${v} は古い。pnpm 11 以上が要る（供給網対策の設定が pnpm 11 未満では効かない）`);
}

/** Chatwoot のユーザーのアクセストークンで自分のプロフィールを読み、アカウントに入れているかを確かめる（読み取りのみ） */
async function verifyToken(ctx, baseUrl, token, accountId) {
  const profile = await ctx.http("Chatwoot のトークンの確認", `${baseUrl}/api/v1/profile`, { headers: { api_access_token: token } });
  const membership = (profile?.accounts ?? []).find((a) => Number(a.id) === Number(accountId));
  if (!membership) throw new Error(`このトークンのユーザーはアカウント ${accountId} に入っていない（chatwoot モジュールの状態 CHATWOOT_ACCOUNT_ID と CHATWOOT_AGENT_TOKEN を確かめる）`);
  return membership.role;
}

export async function check(ctx) {
  const dir = dirOf(ctx);
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  mark(existsSync(join(dir, "node_modules")), "依存は導入済み", "依存が未導入（pnpm install）");
  mark(existsSync(join(dir, "dist/index.js")), "dist/index.js あり", "dist/index.js が無い（pnpm build）");

  const envPath = envPathOf(ctx);
  if (!existsSync(envPath)) {
    notes.push(`${envPath} がまだ無い`);
    return { ok: false, notes };
  }
  mark((statSync(envPath).mode & 0o077) === 0, "env ファイルの権限は 600 系", `${envPath} がほかのユーザーにも読める（chmod 600）`);
  const env = ctx.readEnvFile(envPath);
  const missing = KEYS.filter((k) => !env[k]);
  mark(missing.length === 0, `env ファイルに ${KEYS.join("・")} がある`, `env ファイルに無いキー: ${missing.join("・")}`);
  const stateToken = ctx.state.get("CHATWOOT_AGENT_TOKEN");
  if (stateToken && env.CHATWOOT_API_ACCESS_TOKEN) mark(env.CHATWOOT_API_ACCESS_TOKEN === stateToken, "トークンは状態（エージェント専用ユーザー）と一致", "env ファイルのトークンが状態のエージェント専用ユーザーのものと違う");

  if (missing.length === 0) {
    try {
      const role = await verifyToken(ctx, env.CHATWOOT_BASE_URL, env.CHATWOOT_API_ACCESS_TOKEN, env.CHATWOOT_ACCOUNT_ID);
      notes.push(`Chatwoot に認証できた（役割: ${role}）`);
    } catch (e) {
      if (e.status === 0) notes.push(`Chatwoot に届かないので認証は未確認（${e.message}）`);
      else mark(false, "", `Chatwoot の認証に失敗: ${e.message}`);
    }
  }
  return { ok, notes };
}

export async function apply(ctx) {
  const dir = dirOf(ctx);
  await ensureTooling(ctx);

  // 先に前提の値を確かめる（ビルドに時間をかける前に止める）
  const token = ctx.require("CHATWOOT_AGENT_TOKEN", "chatwoot モジュール（エージェント専用ユーザーの作成）を先に実行する: node setup/setup.mjs --target dev --only chatwoot");
  const accountId = ctx.require("CHATWOOT_ACCOUNT_ID", "chatwoot モジュールを先に実行する: node setup/setup.mjs --target dev --only chatwoot");
  const baseUrl = (ctx.value("CHATWOOT_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");

  ctx.log("pnpm install（lockfile 固定）");
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });
  ctx.log("pnpm build（tsc）");
  await ctx.run("pnpm", ["build"], { cwd: dir });
  if (!existsSync(join(dir, "dist/index.js"))) throw new Error("ビルドしたのに dist/index.js が無い");

  const role = await verifyToken(ctx, baseUrl, token, accountId);
  ctx.log(`エージェント専用ユーザーのトークンで Chatwoot に認証できた（アカウント ${accountId}、役割: ${role}）`);

  // 状態が正。再実行でトークンが変わっていたら env ファイルも更新する（onlyIfEmpty: false）
  const envPath = envPathOf(ctx);
  const changed = ctx.writeEnvFile(envPath, { CHATWOOT_BASE_URL: baseUrl, CHATWOOT_API_ACCESS_TOKEN: token, CHATWOOT_ACCOUNT_ID: String(accountId) }, { onlyIfEmpty: false });
  ctx.log(`${envPath} を用意した（600。書き換えたキー: ${changed.join("・") || "なし"}）`);
  ctx.log("登録名 chatwoot（ops/mcp-registry.yaml）で使える。実 API を叩く検証: cd backend/chatwoot-mcp && pnpm verify（参照のみ。--write は本番に向けない）");
}
