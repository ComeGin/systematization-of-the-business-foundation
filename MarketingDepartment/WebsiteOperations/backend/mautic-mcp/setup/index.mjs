// mautic-mcp（自作 MCP サーバ）の設定。依存の導入 → ビルド → ~/.config/comegin/mcp/mautic-dev.env の作成。
// 出典: backend/mautic-mcp/src/config.ts（変数名）、src/services/mautic-client.ts（POST /oauth/v2/token の client_credentials）、
//       ops/mcp-registry.yaml（env ファイルのパス。TRANSPORT=stdio と MAUTIC_ACCESS_LEVEL は env_vars で渡す）。
// MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET は Mautic の画面で人が作る（mautic モジュールの手順）。ここでは作らない。
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "mautic-mcp", title: "Mautic の MCP サーバ（ビルドと env ファイル）", targets: ["dev"], after: ["mautic"] };

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const KEYS = ["MAUTIC_BASE_URL", "MAUTIC_CLIENT_ID", "MAUTIC_CLIENT_SECRET"];

const dirOf = (ctx) => join(ctx.W, "backend/mautic-mcp");
const envPathOf = (ctx) => join(ctx.CONFIG_DIR, "mcp", "mautic-dev.env");

async function ensureTooling(ctx) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node ${process.versions.node} は古い。mautic-mcp は Node 22.18 以上が要る`);
  let v;
  try {
    v = (await ctx.run("pnpm", ["--version"])).trim();
  } catch {
    throw new Error("pnpm が使えない。pnpm 11 以上を入れる（corepack enable && corepack prepare pnpm@latest --activate など）");
  }
  // pnpm-workspace.yaml の minimumReleaseAge などは pnpm 11 未満では効かない（黙って無効になる）
  if (Number(v.split(".")[0]) < 11) throw new Error(`pnpm ${v} は古い。pnpm 11 以上が要る（供給網対策の設定が pnpm 11 未満では効かない）`);
}

/** client_credentials でトークンを取り、API を 1 件読む。トークンは保存も表示もしない */
async function verifyCredentials(ctx, baseUrl, clientId, clientSecret) {
  let token;
  try {
    const res = await ctx.http("Mautic のトークン取得", `${baseUrl}/oauth/v2/token`, {
      method: "POST",
      form: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
    });
    token = res?.access_token;
  } catch (e) {
    if (e.status === 400 || e.status === 401) {
      throw new Error(`Mautic が API 認証情報を受け付けない（${e.message}）。MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET が合っているか、認証情報の種類が「OAuth 2（client_credentials）」か確かめる`);
    }
    throw e;
  }
  if (!token) throw new Error("Mautic のトークン応答に access_token が無い");
  try {
    await ctx.http("Mautic API の確認", `${baseUrl}/api/contacts?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    if (e.status === 403 || e.status === 401) throw new Error(`トークンは取れたが API が拒否した（${e.message}）。Mautic の設定 > API 設定で「API を有効」にしているか確かめる`);
    throw e;
  }
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
  const stateId = ctx.value("MAUTIC_CLIENT_ID");
  if (stateId && env.MAUTIC_CLIENT_ID) mark(env.MAUTIC_CLIENT_ID === stateId, "クライアント ID は設定・状態と一致", "env ファイルのクライアント ID が設定・状態と違う");
  return { ok, notes };
}

export async function apply(ctx) {
  const dir = dirOf(ctx);
  await ensureTooling(ctx);

  const hint = "Mautic の API 認証情報（OAuth 2）を画面で作って、設定ファイルに書く。mautic モジュールの手順（node setup/setup.mjs --target dev --only mautic）を先に実行する";
  const clientId = ctx.require("MAUTIC_CLIENT_ID", hint);
  const clientSecret = ctx.require("MAUTIC_CLIENT_SECRET", hint);
  const baseUrl = (ctx.value("MAUTIC_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");

  ctx.log("pnpm install（lockfile 固定）");
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });
  ctx.log("pnpm build（tsc）");
  await ctx.run("pnpm", ["build"], { cwd: dir });
  if (!existsSync(join(dir, "dist/index.js"))) throw new Error("ビルドしたのに dist/index.js が無い");

  await verifyCredentials(ctx, baseUrl, clientId, clientSecret);
  ctx.log("API 認証情報でトークンを取り、Mautic の API を読めた");

  // 設定・状態が正。値を変えて再実行したら env ファイルも更新する（onlyIfEmpty: false）
  const envPath = envPathOf(ctx);
  const changed = ctx.writeEnvFile(envPath, { MAUTIC_BASE_URL: baseUrl, MAUTIC_CLIENT_ID: clientId, MAUTIC_CLIENT_SECRET: clientSecret }, { onlyIfEmpty: false });
  ctx.log(`${envPath} を用意した（600。書き換えたキー: ${changed.join("・") || "なし"}）`);
  ctx.log("登録名 mautic（ops/mcp-registry.yaml）で使える。TRANSPORT=stdio と MAUTIC_ACCESS_LEVEL は登録表が渡す（mautic-mcp の既定は http なので、手で動かすときは pnpm start:stdio）");
}
