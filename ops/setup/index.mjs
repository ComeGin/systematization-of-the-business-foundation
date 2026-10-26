// 本番の MCP の env ファイル（ops/mcp-registry.yaml の env: prod の 6 つ）を、prod.conf の値から ~/.config/comegin/mcp/ に書く（600）。
// setup/lib/core.mjs の契約に従う。--target prod だけ。
//
// 書くもの（キー名は登録表と各 MCP サーバの src/config.ts に合わせる。TRANSPORT と *_ACCESS_LEVEL は登録表の env_vars が渡すので書かない）:
//   chatwoot-prod.env    CHATWOOT_BASE_URL・CHATWOOT_API_ACCESS_TOKEN・CHATWOOT_ACCOUNT_ID（エージェント専用ユーザーのトークン。ADR-17）
//   mautic-prod.env      MAUTIC_BASE_URL・MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET
//   mautic-prod-ro.env   同じキー。参照専用ロールの別の API 認証情報（mautic-prod と共有しない。登録表の注記）
//   strapi-prod.env      STRAPI_PROD_TOKEN（オンプレの本番の Strapi の Admin トークン。下書きまで。ADR-17）
//   n8n-prod.env         N8N_PROD_TOKEN（オンプレの本番の n8n の MCP のアクセストークン）
//   posthog-prod.env     POSTHOG_PROD_API_KEY・POSTHOG_PROD_PROJECT_ID（「MCP Server」プリセットで本番のプロジェクトの読み取りだけ）
//
// トークンと API 認証情報は、本番の各管理画面で人が発行する（このモジュールは発行しない）。確かめるのは読み取りだけ:
//   Chatwoot は GET /api/v1/profile（ALB のルール 201。ヘッダーは api-access-token。ALB がアンダースコアのヘッダーを捨てるため）、
//   Mautic は client_credentials のトークンと GET /api/contacts?limit=1、
//   Strapi と n8n は MCP の initialize → tools/list（Strapi は公開・非公開化・削除のツールが出ないこと〈ADR-17〉）。
//   2026-10-26 に開発の Strapi（下書きまでのトークンで 24 本、公開・削除なし）と n8n で、この手順が通ることを確かめた。
//   PostHog は外部の SaaS なので形式だけを見る。
// MCP サーバのプログラム（dist）は、承認済みの main のチェックアウト（CONTROL_MAIN_CHECKOUT）のものが使われる（登録表の args の相対パス）。
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "mcp-prod", title: "本番の MCP の env ファイル（chatwoot・mautic・strapi・n8n・posthog）", targets: ["prod"], after: ["onprem"] };

const DEFAULTS = {
  CHATWOOT_BASE_URL: "https://chat.comegin.com",
  MAUTIC_BASE_URL: "https://mkt.comegin.com",
  STRAPI_MCP_URL: "http://127.0.0.1:1338/mcp", // 登録表の strapi-prod
  N8N_MCP_URL: "http://127.0.0.1:5679/mcp-server/http", // 登録表の n8n-prod
};
// ADR-17: strapi-prod は下書きまで。トークンの権限が広いと、これらのツールが tools/list に出る。
// discard_*_draft（下書きの破棄）は下書きまでの権限でも出る（2026-10-26 に開発で確認）ので含めない
const STRAPI_FORBIDDEN = /^(publish|unpublish|delete)_/;
// n8n の MCP はトークンで絞れない。有効化と実行は人間が行う（TA-07 の 3.3）ので、エージェント定義の tools に入れない
const N8N_HUMAN_ONLY = /^(publish_workflow|unpublish_workflow|execute_workflow|archive_workflow)$/;

const trim = (url) => String(url).replace(/\/+$/, "");
const envPath = (ctx, name) => join(ctx.CONFIG_DIR, "mcp", `${name}.env`);

/** prod.conf から 6 つの env ファイルの中身を組み立てる。足りないキーは missing に入れる */
function plan(ctx) {
  const missing = [];
  const req = (key, hint) => {
    const v = ctx.conf[key];
    if (!v) missing.push(`${key}（${hint}）`);
    return v;
  };
  const chatwootBase = trim(ctx.conf.CHATWOOT_BASE_URL || DEFAULTS.CHATWOOT_BASE_URL);
  const mauticBase = trim(ctx.conf.MAUTIC_BASE_URL || DEFAULTS.MAUTIC_BASE_URL);
  const files = {
    "chatwoot-prod": {
      CHATWOOT_BASE_URL: chatwootBase,
      CHATWOOT_API_ACCESS_TOKEN: req("CHATWOOT_AGENT_TOKEN", "本番の Chatwoot のエージェント専用ユーザー〈担当者の権限〉のアクセストークン"),
      CHATWOOT_ACCOUNT_ID: req("CHATWOOT_ACCOUNT_ID", "本番の Chatwoot のアカウントの数値 ID"),
    },
    "mautic-prod": {
      MAUTIC_BASE_URL: mauticBase,
      MAUTIC_CLIENT_ID: req("MAUTIC_CLIENT_ID", "本番の Mautic の API 認証情報〈OAuth 2〉。エージェント専用"),
      MAUTIC_CLIENT_SECRET: req("MAUTIC_CLIENT_SECRET", "同上"),
    },
    "mautic-prod-ro": {
      MAUTIC_BASE_URL: mauticBase,
      MAUTIC_CLIENT_ID: req("MAUTIC_RO_CLIENT_ID", "参照専用ロールの API 認証情報。mautic-prod と別に作る"),
      MAUTIC_CLIENT_SECRET: req("MAUTIC_RO_CLIENT_SECRET", "同上"),
    },
    "strapi-prod": { STRAPI_PROD_TOKEN: req("STRAPI_PROD_TOKEN", "オンプレの本番の Strapi の Admin トークン。下書きまで〈公開・非公開化・削除なし〉") },
    "n8n-prod": { N8N_PROD_TOKEN: req("N8N_PROD_TOKEN", "オンプレの本番の n8n の MCP のアクセストークン") },
    "posthog-prod": {
      POSTHOG_PROD_API_KEY: req("POSTHOG_PROD_API_KEY", "PostHog の個人 API キー。MCP Server のプリセットで本番のプロジェクトの読み取りだけ"),
      POSTHOG_PROD_PROJECT_ID: req("POSTHOG_PROD_PROJECT_ID", "PostHog の本番のプロジェクトの数値 ID"),
    },
  };
  return { files, missing };
}

/** 値の形の検査（通信しない）。問題ごとに 1 行 */
function shapeProblems(files) {
  const p = [];
  const ro = files["mautic-prod-ro"];
  const rw = files["mautic-prod"];
  if (ro.MAUTIC_CLIENT_ID && ro.MAUTIC_CLIENT_ID === rw.MAUTIC_CLIENT_ID)
    p.push("MAUTIC_RO_CLIENT_ID が MAUTIC_CLIENT_ID と同じ。mautic-prod-ro は参照専用ロールの別の認証情報にする（共有すると ACCESS_LEVEL を下げても上流の権限が残る）");
  for (const [name, key] of [["chatwoot-prod", "CHATWOOT_BASE_URL"], ["mautic-prod", "MAUTIC_BASE_URL"]])
    if (!/^https:\/\//.test(files[name][key])) p.push(`${key}（${files[name][key]}）が https ではない`);
  const id = files["chatwoot-prod"].CHATWOOT_ACCOUNT_ID;
  if (id && !/^\d+$/.test(id)) p.push("CHATWOOT_ACCOUNT_ID が数字ではない");
  const ph = files["posthog-prod"];
  if (ph.POSTHOG_PROD_PROJECT_ID && !/^\d+$/.test(ph.POSTHOG_PROD_PROJECT_ID)) p.push("POSTHOG_PROD_PROJECT_ID が数字ではない");
  if (ph.POSTHOG_PROD_API_KEY && !ph.POSTHOG_PROD_API_KEY.startsWith("phx_")) p.push("POSTHOG_PROD_API_KEY が phx_ で始まらない（プロジェクトのトークン phc_ ではなく、個人 API キーを使う）");
  return p;
}

// ---------------------------------------------------------------------------
// 読み取りだけの確認
// ---------------------------------------------------------------------------

async function verifyChatwoot(ctx, f) {
  const profile = await ctx.http("本番の Chatwoot のトークンの確認", `${f.CHATWOOT_BASE_URL}/api/v1/profile`, {
    headers: { "api-access-token": f.CHATWOOT_API_ACCESS_TOKEN },
  });
  const membership = (profile?.accounts ?? []).find((a) => Number(a.id) === Number(f.CHATWOOT_ACCOUNT_ID));
  if (!membership) throw new Error(`このトークンのユーザーは本番のアカウント ${f.CHATWOOT_ACCOUNT_ID} に入っていない`);
  if (membership.role === "administrator") ctx.warn("chatwoot-prod のトークンのユーザーが管理者。エージェント専用ユーザー（担当者の権限）で発行し直す（ADR-17。操作の主体と権限を分けるため）");
  return membership.role;
}

async function verifyMautic(ctx, label, f) {
  const res = await ctx.http(`${label} のトークン取得`, `${f.MAUTIC_BASE_URL}/oauth/v2/token`, {
    method: "POST",
    form: { grant_type: "client_credentials", client_id: f.MAUTIC_CLIENT_ID, client_secret: f.MAUTIC_CLIENT_SECRET },
  });
  if (!res?.access_token) throw new Error(`${label}: トークンの応答に access_token が無い`);
  await ctx.http(`${label} の API の確認`, `${f.MAUTIC_BASE_URL}/api/contacts?limit=1`, { headers: { Authorization: `Bearer ${res.access_token}` } });
}

/** MCP（Streamable HTTP）の initialize → notifications/initialized → tools/list。ツール名の配列を返す */
async function mcpToolNames(label, url, token) {
  const headers = { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  let session = null;
  const rpc = async (body) => {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      const err = new Error(`${label}: ${new URL(url).origin} に接続できない（${e.cause?.code ?? e.message}）`);
      err.status = 0;
      throw err;
    }
    if (!res.ok) throw Object.assign(new Error(`${label}: HTTP ${res.status}`), { status: res.status });
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    if (!text) return null;
    const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).pop()?.slice(5) : text;
    const json = data ? JSON.parse(data) : null;
    if (json?.error) throw new Error(`${label}: ${json.error.message ?? "MCP のエラー"}`);
    return json?.result ?? null;
  };
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "comegin-setup", version: "1" } } });
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  return (list?.tools ?? []).map((t) => t.name);
}

/** 各 MCP を読み取りだけで確かめる。届かないものは unreachable に入れて、失敗とは分ける */
async function verifyAll(ctx, files) {
  const results = [];
  const unreachable = [];
  const attempt = async (name, fn) => {
    try {
      results.push(`${name}: ${await fn()}`);
    } catch (e) {
      if (e.status === 0) unreachable.push(`${name}（${e.message}）`);
      else throw new Error(`${name}: ${e.message}`);
    }
  };
  await attempt("chatwoot-prod", async () => `認証できた（役割 ${await verifyChatwoot(ctx, files["chatwoot-prod"])}）`);
  await attempt("mautic-prod", async () => (await verifyMautic(ctx, "mautic-prod", files["mautic-prod"]), "トークンを取り、API を読めた"));
  await attempt("mautic-prod-ro", async () => (await verifyMautic(ctx, "mautic-prod-ro", files["mautic-prod-ro"]), "トークンを取り、API を読めた"));
  await attempt("strapi-prod", async () => {
    const names = await mcpToolNames("strapi-prod", DEFAULTS.STRAPI_MCP_URL, files["strapi-prod"].STRAPI_PROD_TOKEN);
    const forbidden = names.filter((n) => STRAPI_FORBIDDEN.test(n));
    if (forbidden.length) throw new Error(`トークンの権限が広い。公開・非公開化・削除のツールが出ている（${forbidden.join(", ")}）。Admin トークンを下書きまでの権限で発行し直す（ADR-17）`);
    return `ツール ${names.length} 本（公開・非公開化・削除なし）`;
  });
  await attempt("n8n-prod", async () => {
    const names = await mcpToolNames("n8n-prod", DEFAULTS.N8N_MCP_URL, files["n8n-prod"].N8N_PROD_TOKEN);
    const humanOnly = names.filter((n) => N8N_HUMAN_ONLY.test(n));
    if (humanOnly.length)
      ctx.warn(`n8n-prod に人間だけが行う操作のツールが出ている（${humanOnly.join(", ")}）。n8n のトークンでは絞れない。これらを tools に含むエージェント定義は control-plane が起動しない（src/runner/agent.ts の HUMAN_ONLY_PROD_TOOLS。TA-07 の 3.3）`);
    return `ツール ${names.length} 本`;
  });
  return { results, unreachable };
}

function writeAll(ctx, files) {
  const written = [];
  for (const [name, values] of Object.entries(files)) {
    // prod.conf が正。値が変われば書き換える
    const changed = ctx.writeEnvFile(envPath(ctx, name), values, { onlyIfEmpty: false });
    written.push(`${name}${changed.length ? `（${changed.join("・")}）` : ""}`);
  }
  return written;
}

/** 登録表の stdio の args は CONTROL_MAIN_CHECKOUT から解決される。そこに dist が無いと chatwoot-prod・mautic-prod* は起動しない */
function missingDist(ctx) {
  const main = ctx.value("CONTROL_MAIN_CHECKOUT");
  if (!main) return ["CONTROL_MAIN_CHECKOUT が prod.conf に無い（登録表の stdio の args は承認済みの main のチェックアウトから解決される。dev.conf と同じ値を書く）"];
  return ["backend/chatwoot-mcp/dist/index.js", "backend/mautic-mcp/dist/index.js"].filter((rel) => !existsSync(join(main, rel))).map((rel) => `${join(main, rel)} が無い`);
}

// ---------------------------------------------------------------------------
// 契約
// ---------------------------------------------------------------------------

export async function check(ctx) {
  const { files, missing } = plan(ctx);
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  mark(missing.length === 0, "prod.conf に本番の MCP の値がそろっている", `prod.conf に無いキー: ${missing.join("・")}`);
  for (const p of shapeProblems(files)) mark(false, "", p);
  for (const name of Object.keys(files)) {
    const path = envPath(ctx, name);
    if (!existsSync(path)) mark(false, "", `${path} がまだ無い`);
    else mark((statSync(path).mode & 0o077) === 0, `${name}.env あり（600 系）`, `${path} がほかのユーザーにも読める（chmod 600）`);
  }
  for (const m of missingDist(ctx)) mark(false, "", m);
  if (ok) {
    try {
      const { results, unreachable } = await verifyAll(ctx, files);
      notes.push(...results);
      for (const u of unreachable) mark(false, "", `届かない: ${u}`);
    } catch (e) {
      mark(false, "", e.message);
    }
  }
  return { ok, notes };
}

export async function apply(ctx) {
  const { files, missing } = plan(ctx);
  if (missing.length) {
    ctx.manual("prod-values", "本番の MCP のトークンと API 認証情報を発行して prod.conf に書く", [
      "発行の手順は setup/manual-steps.md の「本番の MCP」。どれもエージェント専用のアカウントで発行する（人間の管理者のトークンを使わない。ADR-17）",
      `~/.config/comegin/setup/prod.conf に次を書く（chmod 600）: ${missing.join("、")}`,
      `URL の既定（CHATWOOT_BASE_URL=${DEFAULTS.CHATWOOT_BASE_URL}・MAUTIC_BASE_URL=${DEFAULTS.MAUTIC_BASE_URL}）と違うときだけ、そのキーも書く`,
      "同じコマンドを実行し直す",
    ]);
  }
  const problems = shapeProblems(files);
  if (problems.length) throw new Error(`本番の MCP の値に問題がある: ${problems.join("／")}`);

  // 書く前に確かめる（誤った値のファイルを置かない）。オンプレの Strapi・n8n が止まっていて届かないものは、書いてから案内する
  const { results, unreachable } = await verifyAll(ctx, files);
  for (const r of results) ctx.log(r);
  const written = writeAll(ctx, files);
  ctx.log(`~/.config/comegin/mcp/ に書いた（600）: ${written.join("、")}`);

  const dist = missingDist(ctx);
  if (unreachable.length || dist.length) {
    ctx.manual("finish", "本番の MCP の準備の残り", [
      ...unreachable.map((u) => `届かなかったので未確認: ${u}。オンプレの本番（onprem モジュール）を起動してから、同じコマンドを実行し直す`),
      ...dist.map((d) => `${d}。承認済みの main のチェックアウトで、人が pnpm install && pnpm build する（backend/chatwoot-mcp・backend/mautic-mcp）`),
    ]);
  }
  ctx.log("登録名 chatwoot-prod・mautic-prod・mautic-prod-ro・strapi-prod・n8n-prod・posthog-prod（ops/mcp-registry.yaml）で使える。PostHog は外部の SaaS なので、キーの形式だけを確かめた");
}
