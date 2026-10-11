// Strapi（開発環境。http://127.0.0.1:1337）の設定。setup/lib/core.mjs の契約に従う。
//
// やること: 環境変数ファイル → pnpm install → 開発サーバーの応答待ち → 管理者 → API トークン 2 つ → MCP の env ファイル
//
// 確かめた出典（@strapi/* 5.53.0 の node_modules 内のソース。ctx の呼び出しは実機では未実行）:
//   - 管理者の作成・ログイン: @strapi/admin dist/server/server/src/routes/{admin,authentication}.js（GET /admin/init、POST /admin/register-admin、POST /admin/login）
//   - 公式 CLI `strapi admin:create-user` は、パスワードを --password の引数でしか受けない（対話は TTY のみ。@strapi/strapi dist/src/cli/commands/admin/create-user.js）。
//     引数に秘密値を入れないため、初回の管理者は CLI ではなく管理 API の register-admin（管理者が 1 人もいないときだけ通る）で作る
//   - Admin トークン（MCP 用）: controllers/admin-token.js・validation/admin-tokens.js（POST /admin/admin-tokens、
//     所有者だけが GET で鍵を読める・regenerate できる）。権限は adminPermissions: [{ action, subject, properties }]
//   - Content API トークン（ビルド用）: controllers/api-token.js（POST /admin/api-tokens。GET /admin/api-tokens/:id が鍵を返す）
//   - MCP の認証は Admin トークン、ツールはトークンの権限に絞られる（@strapi/core dist/services/mcp/authentication.js、
//     @strapi/content-manager dist/server/mcp/derive-content-type-mcp-tools.js）。ツール名は list_/get_/create_/update_/delete_/publish_/unpublish_/discard_ ＋ スラグ
//   - i18n は properties.locales が未指定だと「どのロケールも不可」になる（@strapi/i18n dist/server/services/permissions/engine.js）ため、locales: null（全ロケール）を明示する
import { existsSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "strapi", title: "Strapi（CMS。開発環境）", targets: ["dev"], after: [] };

const DIR = "backend/strapi-system";
const BASE = "http://127.0.0.1:1337";
const BUILD_TOKEN_NAME = "setup-build-readonly";
const MCP_TOKEN_NAME = "setup-mcp-dev";
const PLACEHOLDER = /tobemodified/i;

// MCP 用トークンの権限。draft は「下書きまで」（作成・読み取り・更新。公開・非公開化・削除なし）で、本番（strapi-prod。ADR-17）と同じ形。
// full は開発環境で全部を試したいとき（~/.config/comegin/setup/dev.conf に STRAPI_DEV_TOKEN_SCOPE=full）。
const WRITABLE = ["api::article.article", "api::author.author", "api::category.category", "api::keyword.keyword", "api::content-plan.content-plan"];
const SINGLES = ["api::about.about", "api::global.global"];
const A = "plugin::content-manager.explorer.";

function mcpPermissions(scope, existing) {
  const has = (uid) => !existing || existing.has(uid);
  const perm = (action, subject) => ({ action: `${A}${action}`, subject, properties: { locales: null } });
  const out = [];
  for (const uid of [...WRITABLE, ...SINGLES]) if (has(uid)) out.push(perm("read", uid));
  for (const uid of WRITABLE) {
    if (!has(uid)) continue;
    out.push(perm("create", uid), perm("update", uid));
    if (scope === "full") out.push(perm("delete", uid), perm("publish", uid));
  }
  if (scope === "full") for (const uid of SINGLES) if (has(uid)) out.push(perm("update", uid));
  return out;
}

const scopeOf = (ctx) => (ctx.value("STRAPI_DEV_TOKEN_SCOPE") === "full" ? "full" : "draft");

/** 管理画面のパスワードの規則（8 文字以上・72 バイト以下・英大小文字と数字を含む）を満たす値を作る */
function strongPassword(ctx) {
  for (;;) {
    const p = ctx.randomSecret(18);
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p;
  }
}

async function responding(ctx) {
  try {
    const res = await ctx.http("Strapi", `${BASE}/_health`, { raw: true, timeoutMs: 5_000 });
    return res.status < 500;
  } catch {
    return false;
  }
}

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

/** 環境変数ファイルに入れる秘密値。空・雛形の値（tobemodified）のキーだけ。既存の本物の値は変えない */
function envUpdates(ctx, envPath) {
  const cur = ctx.readEnvFile(envPath);
  const empty = (k) => !cur[k] || PLACEHOLDER.test(cur[k]);
  const want = {};
  if (empty("APP_KEYS")) want.APP_KEYS = [1, 2, 3, 4].map(() => ctx.randomSecret(16)).join(",");
  for (const k of ["API_TOKEN_SALT", "ADMIN_JWT_SECRET", "TRANSFER_TOKEN_SALT", "JWT_SECRET", "ENCRYPTION_KEY"]) if (empty(k)) want[k] = ctx.randomSecret(24);
  const posthog = ctx.value("POSTHOG_PROJECT_TOKEN");
  if (posthog && empty("POSTHOG_PROJECT_TOKEN")) want.POSTHOG_PROJECT_TOKEN = posthog;
  return want;
}

export async function check(ctx) {
  const dir = join(ctx.W, DIR);
  const envPath = join(dir, ".env");
  const notes = [];
  const envOk = existsSync(envPath) && Object.keys(envUpdates(ctx, envPath)).filter((k) => k !== "POSTHOG_PROJECT_TOKEN").length === 0;
  notes.push(`.env: ${envOk ? "秘密値が入っている" : "秘密値が足りない（apply で入れる）"}`);
  notes.push(`node_modules: ${existsSync(join(dir, "node_modules")) ? "ある" : "無い（apply で pnpm install）"}`);
  const up = await responding(ctx);
  notes.push(`開発サーバー（${BASE}）: ${up ? "応答あり" : "応答なし（別の端末で pnpm dev）"}`);
  let adminOk = false;
  if (up) {
    const init = await ctx.http("Strapi", `${BASE}/admin/init`).catch(() => null);
    notes.push(`管理者: ${init?.data?.hasAdmin ? "いる" : "まだいない（apply で作る）"}`);
    adminOk = Boolean(init?.data?.hasAdmin);
  }
  let tokensOk = false;
  if (up && ctx.state.has("STRAPI_BUILD_TOKEN")) {
    const r = await ctx.http("Strapi", `${BASE}/api/articles?pagination[pageSize]=1`, { headers: authHeader(ctx.state.get("STRAPI_BUILD_TOKEN")) }).then(() => true, () => false);
    notes.push(`STRAPI_BUILD_TOKEN: ${r ? "使える" : "使えない（apply で作り直す）"}`);
    tokensOk = r;
  } else notes.push(`STRAPI_BUILD_TOKEN: ${ctx.state.has("STRAPI_BUILD_TOKEN") ? "状態にある（サーバーが止まっていて確かめられない）" : "まだ"}`);
  notes.push(`STRAPI_DEV_TOKEN: ${ctx.state.has("STRAPI_DEV_TOKEN") ? "状態にある" : "まだ"}／strapi-dev.env: ${existsSync(join(ctx.CONFIG_DIR, "mcp/strapi-dev.env")) ? "ある" : "まだ"}`);
  return { ok: envOk && up && adminOk && tokensOk && ctx.state.has("STRAPI_DEV_TOKEN") && existsSync(join(ctx.CONFIG_DIR, "mcp/strapi-dev.env")), notes };
}

export async function apply(ctx) {
  const dir = join(ctx.W, DIR);

  // 1. 環境変数ファイル（.env.example を雛形に、空・雛形のままのキーだけ書く）
  const envPath = join(dir, ".env");
  const changed = ctx.writeEnvFile(envPath, envUpdates(ctx, envPath), { template: join(dir, ".env.example"), onlyIfEmpty: false });
  ctx.log(changed.length ? `.env に書いた: ${changed.join(", ")}` : ".env は用意できている");
  if (PLACEHOLDER.test(ctx.readEnvFile(envPath).POSTHOG_PROJECT_TOKEN ?? "")) ctx.warn("POSTHOG_PROJECT_TOKEN が雛形の値のまま（イベントは PostHog に届かない。必要なら設定に POSTHOG_PROJECT_TOKEN を書いて再実行）");

  // 2. 依存パッケージ（lockfile のとおりに入れる。lockfile は変えない）
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });
  ctx.log("pnpm install: 済み");

  // 3. 開発サーバー（setup は常駐プロセスを持たない。止まっていれば人に起動を頼む）
  const up = await responding(ctx);
  if (!up) {
    ctx.manual("start-dev", "Strapi の開発サーバーを起動する", [`別の端末で: cd ${dir} && pnpm dev`, `${BASE}/_health が 204 を返したら（数十秒かかる）、同じコマンドを実行し直す`]);
  }
  if (changed.some((k) => k !== "POSTHOG_PROJECT_TOKEN")) ctx.warn("起動中のサーバーは書き換え前の値で動いている。次に pnpm dev を起動し直したとき、新しい値になる");

  // 4. 管理者
  const email = ctx.value("STRAPI_ADMIN_EMAIL") || ctx.require("ADMIN_EMAIL");
  const init = await ctx.http("Strapi", `${BASE}/admin/init`);
  if (!init?.data?.hasAdmin) {
    const password = strongPassword(ctx);
    // register-admin は管理者が 1 人もいないときだけ通る（引数に秘密値を出さずに済む）
    await ctx.http("Strapi（管理者の作成）", `${BASE}/admin/register-admin`, { method: "POST", json: { email, password, firstname: "Admin", lastname: "ComeGin" } });
    ctx.state.set("STRAPI_ADMIN_PASSWORD", password, { secret: true });
    ctx.log(`管理者を作った（${email}。パスワードは --show STRAPI_ADMIN_PASSWORD）`);
  } else ctx.log("管理者は作成済み");

  const password = ctx.value("STRAPI_ADMIN_PASSWORD");
  if (!password) {
    ctx.manual("admin-password", "既にいる Strapi の管理者のパスワードを設定に書く", [
      `~/.config/comegin/setup/dev.conf に STRAPI_ADMIN_PASSWORD=<管理者のパスワード> を書く（メールが ADMIN_EMAIL と違うなら STRAPI_ADMIN_EMAIL=<メール> も）`,
      "忘れたとき: 開発サーバーを止めて cd " + dir + " && pnpm strapi admin:reset-user-password -e <メール> -p <新しいパスワード>（引数に出るので自分の端末だけで。大文字・小文字・数字を含む 8 文字以上）",
      "同じコマンドを実行し直す",
    ]);
  }

  // 5. トークン（状態に値があって使えるなら、ログインせずに飛ばす）
  const buildOk = await tokenWorks(ctx, "STRAPI_BUILD_TOKEN", (t) => ctx.http("Strapi", `${BASE}/api/articles?pagination[pageSize]=1`, { headers: authHeader(t) }));
  // 権限の無いトークンでも MCP は 200 で log だけを返すので、記事の一覧のツールが出ることまで見る（権限 0 件のトークンを作り直すため）
  const mcpOk = await tokenWorks(ctx, "STRAPI_DEV_TOKEN", async (t) => {
    if (!(await mcpToolNames(ctx, t)).includes("list_article")) throw new Error("権限が足りない");
  });
  if (!buildOk || !mcpOk) {
    const jwt = await login(ctx, email, password);
    const admin = (path, opts = {}) => ctx.http("Strapi（管理 API）", `${BASE}/admin${path}`, { ...opts, headers: authHeader(jwt) });
    if (!buildOk) {
      const key = await ensureToken(ctx, admin, { kind: "api-tokens", name: BUILD_TOKEN_NAME, create: { name: BUILD_TOKEN_NAME, description: "Astro のビルド用（読み取りだけ。setup が作成）", type: "read-only", lifespan: null } });
      ctx.state.set("STRAPI_BUILD_TOKEN", key, { secret: true });
      ctx.log("STRAPI_BUILD_TOKEN（読み取り専用の API トークン）を用意した");
    }
    const scope = scopeOf(ctx);
    let existing = null;
    try {
      // content-manager の API は /admin の下ではない（/admin/* は管理画面の HTML を 200 で返すので、JSON として読めず 0 件に見える）
      const types = await ctx.http("Strapi（コンテンツタイプ）", `${BASE}/content-manager/content-types`, { headers: authHeader(jwt) });
      const uids = (types?.data ?? []).map((t) => t.uid);
      if (uids.length === 0) throw new Error("一覧が空");
      existing = new Set(uids);
      const missing = [...WRITABLE, ...SINGLES].filter((u) => !existing.has(u));
      if (missing.length) ctx.warn(`開発サーバーに無いコンテンツタイプは権限から外す: ${missing.join(", ")}（サーバーを再起動して再実行すれば入る）`);
    } catch (e) {
      ctx.warn(`コンテンツタイプの一覧を取れなかった（${e.message}）。全部の型に権限を付ける`);
      existing = null;
    }
    const permissions = mcpPermissions(scope, existing);
    if (permissions.length === 0) throw new Error("Strapi: MCP 用トークンに付ける権限が 0 件になった（コンテンツタイプが 1 つも見つからない）。開発サーバーのログを確かめる");
    const key = await ensureToken(ctx, admin, {
      kind: "admin-tokens",
      name: MCP_TOKEN_NAME,
      create: { name: MCP_TOKEN_NAME, description: `strapi-mcp 用（${scope === "full" ? "全権限" : "下書きまで"}。setup が作成）`, lifespan: null, adminPermissions: permissions },
      permissions,
    });
    ctx.state.set("STRAPI_DEV_TOKEN", key, { secret: true });
    ctx.log(`STRAPI_DEV_TOKEN（MCP 用の Admin トークン。権限: ${scope === "full" ? "全権限" : "下書きまで"}）を用意した`);
  } else ctx.log("トークンは使える状態");

  // 6. MCP の env ファイル（ops/mcp-registry.yaml の strapi-mcp が読む）
  const mcpEnv = join(ctx.CONFIG_DIR, "mcp", "strapi-dev.env");
  ctx.writeEnvFile(mcpEnv, { STRAPI_DEV_TOKEN: ctx.state.get("STRAPI_DEV_TOKEN") }, { onlyIfEmpty: false });
  ctx.log("~/.config/comegin/mcp/strapi-dev.env に書いた（600）");

  // 7. MCP のツール一覧で、権限が意図どおりかを確かめる（本番で「公開だけを外せるか」の事前確認。TA-07 の 9 節）
  try {
    const tools = await mcpToolNames(ctx, ctx.state.get("STRAPI_DEV_TOKEN"));
    const publish = tools.filter((n) => /^(publish|unpublish)_/.test(n));
    const del = tools.filter((n) => n.startsWith("delete_"));
    ctx.log(`MCP のツール ${tools.length} 個（create_article: ${tools.includes("create_article") ? "あり" : "なし"}／公開系: ${publish.length}／削除系: ${del.length}）`);
    if (scopeOf(ctx) === "draft" && (publish.length || del.length)) ctx.warn(`下書きまでのはずなのに公開・削除のツールが出ている: ${[...publish, ...del].join(", ")}（権限の絞りが効いていない。本番の前に調べる）`);
  } catch (e) {
    ctx.warn(`MCP のツール一覧を取れなかった（${e.message}）。strapi-mcp の接続は手で確かめる`);
  }
}

/** 状態にあるトークンが使えるか。値が無い・使えないなら false */
async function tokenWorks(ctx, key, probe) {
  if (!ctx.state.has(key)) return false;
  try {
    await probe(ctx.state.get(key));
    return true;
  } catch {
    return false;
  }
}

async function login(ctx, email, password) {
  try {
    const res = await ctx.http("Strapi（ログイン）", `${BASE}/admin/login`, { method: "POST", json: { email, password } });
    const jwt = res?.data?.token ?? res?.data?.accessToken;
    if (!jwt) throw new Error("Strapi（ログイン）: 応答にトークンが無い");
    return jwt;
  } catch (e) {
    if (e.status === 400 || e.status === 401) {
      ctx.manual("admin-login", "Strapi の管理者でログインできない", [
        `設定（~/.config/comegin/setup/dev.conf）か状態の STRAPI_ADMIN_PASSWORD が、${email} の今のパスワードと合っていない`,
        "管理画面（http://127.0.0.1:1337/admin）で今のパスワードを確かめるか、開発サーバーを止めて cd backend/strapi-system && pnpm strapi admin:reset-user-password -e <メール> -p <新しいパスワード>",
        "設定の STRAPI_ADMIN_PASSWORD を直して（状態に同名の値があるなら、設定のほうが優先される）、同じコマンドを実行し直す",
      ]);
    }
    throw e;
  }
}

/**
 * 名前でトークンを探し、鍵を返す。無ければ作る。鍵が読めなければ作り直す（regenerate）。
 * Content API のトークンは GET /:id が鍵を返し、Admin トークンは所有者だけが GET で読める（作成者＝この管理者）。
 * 権限（permissions）を渡したときは、既存のトークンの権限もそろえる（PUT）。
 */
async function ensureToken(ctx, admin, { kind, name, create, permissions }) {
  const list = await admin(`/${kind}`);
  const found = (list?.data ?? []).find((t) => t.name === name);
  if (!found) {
    const res = await admin(`/${kind}`, { method: "POST", json: create });
    const key = res?.data?.accessKey;
    if (!key) throw new Error(`Strapi: トークン ${name} を作ったが、応答に鍵が無い`);
    return key;
  }
  if (permissions) await admin(`/${kind}/${found.id}`, { method: "PUT", json: { adminPermissions: permissions } });
  const got = await admin(`/${kind}/${found.id}`).catch(() => null);
  if (got?.data?.accessKey) return got.data.accessKey;
  const regen = await admin(`/${kind}/${found.id}/regenerate`, { method: "POST" }).catch((e) => {
    if (e.status === 403) throw new Error(`Strapi: トークン ${name} は別の管理者が作ったもので、作り直せない。管理画面（設定 → API トークン）で消してから再実行する`);
    throw e;
  });
  const key = regen?.data?.accessKey;
  if (!key) throw new Error(`Strapi: トークン ${name} の作り直しの応答に鍵が無い`);
  ctx.log(`トークン ${name} は既にあったが鍵が読めないので作り直した`);
  return key;
}

/** MCP（POST /mcp。ステートレスな JSON-RPC）の tools/list。応答は JSON か SSE のどちらでも読む */
async function mcpToolNames(ctx, token) {
  const res = await ctx.http("Strapi（MCP）", `${BASE}/mcp`, {
    method: "POST",
    headers: { ...authHeader(token), Accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    raw: true,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Strapi（MCP）: HTTP ${res.status}`);
  const messages = /^data:/m.test(text) ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))) : [JSON.parse(text)];
  const tools = messages.find((m) => m?.result?.tools)?.result.tools;
  if (!tools) throw new Error("Strapi（MCP）: tools/list の応答にツールが無い");
  return tools.map((t) => t.name);
}
