// Umami（開発環境）の設定。起動（MCP を有効にして）→ 管理者のパスワードの変更 → Web サイト → API キー → MCP の env ファイル。
//
// 方針（setup/lib/core.mjs の契約）:
//   - 使うのは Umami の公式の REST API だけ（画面も DB も触らない）。umami-master は上流の取り込みなので、独自の追加は dev/setup/ の中だけ
//   - 上流の docker-compose.yml は MCP が無効（MCP_ENABLED=1 が無いと /mcp は 404）。上流は変えず、dev/setup/compose.mcp.yml で上書きして起動する
//   - API キーは「ログインして得たトークン」で作る（API キー自身では /api/me/api-keys を呼べない）。平文は作成時にしか返らないので、状態と MCP の env に置く
//
// 確かめた出典（middleware/umami-master のソース v3.4.0。動いているコンテナも同じ版）:
//   src/app/api/auth/login/route.ts（POST /api/auth/login → { token }。上流の既定の管理者は admin / umami）
//   src/app/api/me/password/route.ts（POST { currentPassword, newPassword }。8 文字以上）
//   src/app/api/websites/{route.ts,request-schema.ts}（GET 一覧は { data }、POST { name, domain }。domain は localhost 可）
//   src/app/api/me/api-keys/route.ts（POST { name } → { key }。CLOUD_MODE でなければ使える）、src/lib/api-key.ts（キーは umami_ で始まる。/api/me/api-keys などは API キーでは呼べない）
//   src/app/mcp/route.ts・src/lib/mcp/auth.ts（MCP_ENABLED=1 のときだけ。Bearer の API キーだけを受ける。無効なら 404、キーが無い・違うなら 401）
//   ops/mcp-registry.yaml（umami: http://127.0.0.1:3000/mcp、Authorization: Bearer ${UMAMI_DEV_API_KEY}、env は umami-dev.env）
import { join } from "node:path";

export const meta = { id: "umami", title: "Umami（アクセス解析。開発環境）", targets: ["dev"], after: [] };

const DIR = "middleware/umami-master";
const BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_SITE_URL = "http://localhost:4321"; // 開発の公開サイト（Astro dev）
const ADMIN_USER = "admin";
const DEFAULT_PASSWORD = "umami"; // 上流の初期の管理者のパスワード
const API_KEY_NAME = "comegin-mcp-dev";
const MCP_ENV = ["mcp", "umami-dev.env"];

const root = (ctx) => join(ctx.W, DIR);
const siteUrl = (ctx) => ctx.value("PUBLIC_SITE_URL") || DEFAULT_SITE_URL;
const mcpEnvPath = (ctx) => join(ctx.CONFIG_DIR, ...MCP_ENV);
const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

// ---------------------------------------------------------------------------
// 起動と MCP
// ---------------------------------------------------------------------------

/** 未認証で /mcp を叩く。有効なら 401、MCP_ENABLED が無ければ 404、応答が無ければ null */
async function mcpStatus() {
  const res = await fetch(`${BASE_URL}/mcp`, { method: "POST", signal: AbortSignal.timeout(8_000) }).catch(() => null);
  return res?.status ?? null;
}

async function ensureStack(ctx) {
  await ctx.run("docker", ["compose", "-f", "docker-compose.yml", "-f", "dev/setup/compose.mcp.yml", "up", "-d"], { cwd: root(ctx) });
  if (!(await ctx.waitForHttp(`${BASE_URL}/api/heartbeat`, { timeoutMs: 180_000 }))) throw new Error(`Umami が ${BASE_URL} で応答しない。docker compose logs umami を見る（${DIR}）`);
  const status = await mcpStatus();
  if (status !== 401) throw new Error(`Umami の /mcp が有効になっていない（未認証で 401 のはずが ${status}）。compose.mcp.yml で MCP_ENABLED=1 を渡せているか、docker compose logs umami を確かめる`);
  ctx.log("起動している（MCP は有効）");
}

// ---------------------------------------------------------------------------
// 管理者
// ---------------------------------------------------------------------------

/** ログインして JWT を返す。ユーザー名かパスワードが違えば null */
async function login(ctx, username, password) {
  try {
    const body = await ctx.http("Umami ログイン", `${BASE_URL}/api/auth/login`, { method: "POST", json: { username, password } });
    if (body?.requiresTwoFactor) throw new Error("Umami の管理者に 2 要素認証が設定されている。API ではログインできないので、設定した人が API キーを画面で作る");
    return body?.token ?? null;
  } catch (e) {
    if (e.status === 401) return null;
    throw e;
  }
}

/** 管理者の JWT を返す。初期のパスワードなら、生成した値に変えてから取り直す */
async function ensureAdmin(ctx) {
  const known = ctx.value("UMAMI_ADMIN_PASSWORD");
  if (known) {
    const token = await login(ctx, ADMIN_USER, known);
    if (token) {
      ctx.state.set("UMAMI_ADMIN_PASSWORD", known, { secret: true });
      ctx.log("管理者でログインできた");
      return token;
    }
  }

  // 初期のパスワードのままか（初回。または、変更の途中で止まった）
  const initial = await login(ctx, ADMIN_USER, DEFAULT_PASSWORD);
  if (initial) {
    const next = known || `${ctx.randomSecret(24)}`;
    ctx.state.set("UMAMI_ADMIN_PASSWORD", next, { secret: true }); // 変更の前に置く（途中で止まっても失わない）
    await ctx.http("Umami パスワード変更", `${BASE_URL}/api/me/password`, { method: "POST", ...bearer(initial), json: { currentPassword: DEFAULT_PASSWORD, newPassword: next } });
    const token = await login(ctx, ADMIN_USER, next);
    if (!token) throw new Error("Umami のパスワードを変えた後にログインできない");
    ctx.log("管理者のパスワードを初期値から生成した値に変えた（`--show UMAMI_ADMIN_PASSWORD`）");
    return token;
  }

  ctx.manual("admin-password", `Umami の管理者（${ADMIN_USER}）のパスワードが初期値ではなく、このスクリプトも知らない`, [
    "管理者のパスワードを知っている場合: ~/.config/comegin/setup/dev.conf に UMAMI_ADMIN_PASSWORD=<そのパスワード> を書く（chmod 600）",
    "知らない場合: API・CLI にはパスワードを再設定する手段が無い。開発環境の Umami のデータを作り直してよければ、自分で docker compose down -v を実行してから、このコマンドを実行し直す（スクリプトはデータを消さない）",
    "書いたら、同じコマンドを実行し直す",
  ]);
}

// ---------------------------------------------------------------------------
// Web サイトと API キー
// ---------------------------------------------------------------------------

async function ensureWebsite(ctx, jwt) {
  const domain = new URL(siteUrl(ctx)).hostname;
  const list = await ctx.http("Umami Web サイト一覧", `${BASE_URL}/api/websites?pageSize=200`, bearer(jwt));
  let website = (list.data ?? []).find((w) => w.id === ctx.state.get("UMAMI_WEBSITE_ID")) ?? (list.data ?? []).find((w) => w.domain === domain);
  if (!website) {
    website = await ctx.http("Umami Web サイト作成", `${BASE_URL}/api/websites`, { method: "POST", ...bearer(jwt), json: { name: "ComeGin（開発）", domain } });
    ctx.log(`Web サイトを作った（ドメイン ${domain}）`);
  } else {
    ctx.log(`Web サイトは既にある（${website.name}）`);
  }
  ctx.state.set("UMAMI_WEBSITE_ID", website.id);
}

async function keyWorks(ctx, key) {
  try {
    await ctx.http("Umami API キーの確認", `${BASE_URL}/api/me`, bearer(key));
    return true;
  } catch (e) {
    if (e.status === 401 || e.status === 403) return false;
    throw e;
  }
}

async function ensureApiKey(ctx, jwt) {
  let key = ctx.state.get("UMAMI_API_KEY");
  if (!key || !(await keyWorks(ctx, key))) {
    const created = await ctx.http("Umami API キー作成", `${BASE_URL}/api/me/api-keys`, { method: "POST", ...bearer(jwt), json: { name: API_KEY_NAME } });
    key = created.key;
    if (!key) throw new Error("Umami の API キーが応答に無い（CLOUD_MODE のときは API キーを作れない）");
    ctx.state.set("UMAMI_API_KEY", key, { secret: true });
    ctx.log(`API キーを作った（名前 ${API_KEY_NAME}）`);
  } else {
    ctx.log("API キーは有効");
  }

  // MCP の env（ops/mcp-registry.yaml の変数名）。このファイルは MCP のためだけなので、値が違えば書き換える
  ctx.writeEnvFile(mcpEnvPath(ctx), { UMAMI_DEV_API_KEY: key }, { onlyIfEmpty: false });
  ctx.log(`MCP の env を書いた（${mcpEnvPath(ctx)}。権限 600）`);

  // 認証が通ることを MCP の口で確かめる（401・404 は失敗。プロトコルの細部の違いによる 400 などは認証が通った印として扱う）
  const res = await ctx.http("Umami MCP の確認", `${BASE_URL}/mcp`, {
    method: "POST",
    raw: true,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  if (res.status === 401 || res.status === 404) throw new Error(`Umami の MCP が API キーを受け付けない（HTTP ${res.status}）`);
  ctx.log(`MCP は API キーを受け付けた（HTTP ${res.status}）`);
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const notes = [];
  const status = await mcpStatus();
  notes.push(status === null ? `Umami が ${BASE_URL} で応答しない` : status === 401 ? "Umami は起動していて、MCP は有効" : `Umami の MCP が無効（/mcp が ${status}。compose.mcp.yml を付けて起動し直す）`);
  let ok = status === 401;

  for (const key of ["UMAMI_ADMIN_PASSWORD", "UMAMI_WEBSITE_ID", "UMAMI_API_KEY"]) {
    if (!ctx.state.has(key)) {
      notes.push(`${key} がまだ状態に無い`);
      ok = false;
    }
  }
  if (ok && ctx.state.has("UMAMI_API_KEY")) {
    const works = await keyWorks(ctx, ctx.state.get("UMAMI_API_KEY"));
    notes.push(works ? "API キーは有効" : "API キーが無効");
    if (!works) ok = false;
  }
  const env = ctx.readEnvFile(mcpEnvPath(ctx));
  const envOk = Boolean(env.UMAMI_DEV_API_KEY) && env.UMAMI_DEV_API_KEY === ctx.state.get("UMAMI_API_KEY");
  notes.push(envOk ? "MCP の env（umami-dev.env）は状態の API キーと一致" : "MCP の env（umami-dev.env）が無いか、状態の API キーと違う");
  if (!envOk) ok = false;
  return { ok, notes };
}

export async function apply(ctx) {
  await ensureStack(ctx);
  const jwt = await ensureAdmin(ctx);
  await ensureWebsite(ctx, jwt);
  await ensureApiKey(ctx, jwt);
  ctx.log(`終わった。管理者のパスワード: --show UMAMI_ADMIN_PASSWORD／画面: ${BASE_URL}（ユーザー名 ${ADMIN_USER}）`);
}
