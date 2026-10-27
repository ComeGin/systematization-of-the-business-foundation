// 本番の MCP の env ファイル（ops/mcp-registry.yaml の env: prod の 6 つ）を、prod.conf の値から ~/.config/comegin/mcp/ に書く（600）。
// setup/lib/core.mjs の契約に従う。--target prod だけ。
//
// 書くもの（キー名は登録表と各 MCP サーバの src/config.ts に合わせる。TRANSPORT と *_ACCESS_LEVEL は登録表の env_vars が渡すので書かない）:
//   chatwoot-prod.env    CHATWOOT_BASE_URL・CHATWOOT_API_ACCESS_TOKEN・CHATWOOT_ACCOUNT_ID（エージェント専用ユーザー〈担当者の権限〉のトークン。ADR-17）
//   mautic-prod.env      MAUTIC_BASE_URL・MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET
//   mautic-prod-ro.env   同じキー。別の API 認証情報（登録表の env_vars で MAUTIC_ACCESS_LEVEL: read_only）
//   strapi-prod.env      STRAPI_PROD_TOKEN（オンプレの本番の Strapi の Admin トークン。下書きまで。ADR-17）
//   n8n-prod.env         N8N_PROD_TOKEN（オンプレの本番の n8n の MCP のアクセストークン）
//   posthog-prod.env     POSTHOG_PROD_API_KEY・POSTHOG_PROD_PROJECT_ID（「MCP Server」プリセットで本番のプロジェクトの読み取りだけ）
//
// Mautic の API 認証情報の上流の権限は、どれも管理者になる（2026-10-27 に上流で確認。ApiBundle の ClientController は、client_credentials を
// 管理者が作ったときだけ付け、ロールは作った人のものを付ける。ロールを選ぶ項目は無い）。mautic-prod と mautic-prod-ro の違いは
// MCP サーバの ACCESS_LEVEL（登録表）とエージェント定義の tools の許可リストだけで、Mautic 側では絞れない。認証情報を分けるのは、
// 片方を失効・入れ替えしても、もう片方を止めないため（manual-steps.md の 8.2）。
//
// トークンと API 認証情報は、本番の各管理画面で人が発行する（このモジュールは発行しない）。確かめるのはデータの読み取りだけ:
//   Chatwoot は GET /api/v1/profile（ALB のルール 203。ヘッダーは api-access-token。ALB がアンダースコアのヘッダーを捨てるため）、
//   Mautic は client_credentials のトークンと GET /api/contacts?limit=1、
//   Strapi と n8n は MCP の initialize → tools/list（Strapi は公開・非公開化・削除のツールが出ないこと〈ADR-17〉）。
//   check も、認証のためのトークンの発行（Mautic）と MCP のセッションの作成・終了は行う（データは書かない）。
//   PostHog は外部の SaaS なので形式だけを見る。
// MCP サーバのプログラム（dist）は、承認済みの main のチェックアウト（CONTROL_MAIN_CHECKOUT）のものが使われる（登録表の args の相対パス）。
// そのため、main の chatwoot-mcp がハイフンのヘッダー（api-access-token）で送る版かも確かめる（古い版はアンダースコアで送り、ALB に捨てられて 401 になる）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const meta = { id: "mcp-prod", title: "本番の MCP の env ファイル（chatwoot・mautic・strapi・n8n・posthog）", targets: ["prod"], after: ["onprem", "chatwoot-prod", "mautic-prod"] };

const DEFAULTS = {
  CHATWOOT_BASE_URL: "https://chat.comegin.com",
  MAUTIC_BASE_URL: "https://mkt.comegin.com",
  STRAPI_MCP_URL: "http://127.0.0.1:1338/mcp", // 登録表の strapi-prod
  N8N_MCP_URL: "http://127.0.0.1:5679/mcp-server/http", // 登録表の n8n-prod
};
const MCP_PROTOCOL_VERSION = "2025-06-18";
// ADR-17: strapi-prod は下書きまで。トークンの権限が広いと、これらのツールが tools/list に出る。
// discard_*_draft（下書きの破棄）は下書きまでの権限でも出る（2026-10-26 に開発で確認）ので含めない
const STRAPI_FORBIDDEN = /^(publish|unpublish|delete)_/;
// n8n の MCP はトークンで絞れない。これらを tools に含むエージェント定義は control-plane が起動しない（src/runner/agent.ts）
const N8N_HUMAN_ONLY = /^(publish_workflow|unpublish_workflow|execute_workflow|archive_workflow)$/;
// main の chatwoot-mcp の dist が、ヘッダーをハイフンの綴りで送る版か（backend/chatwoot-mcp/src/services/chatwoot-client.ts）
const CHATWOOT_MCP_CLIENT = "backend/chatwoot-mcp/dist/services/chatwoot-client.js";

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
      MAUTIC_CLIENT_ID: req("MAUTIC_CLIENT_ID", "本番の Mautic の API 認証情報〈OAuth 2。管理者が作る〉。エージェントの書き込み用"),
      MAUTIC_CLIENT_SECRET: req("MAUTIC_CLIENT_SECRET", "同上"),
    },
    "mautic-prod-ro": {
      MAUTIC_BASE_URL: mauticBase,
      MAUTIC_CLIENT_ID: req("MAUTIC_RO_CLIENT_ID", "analytics-reporter 用の別の API 認証情報〈管理者が作る〉"),
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
function shapeProblems(ctx, files) {
  const p = [];
  const ro = files["mautic-prod-ro"];
  const rw = files["mautic-prod"];
  if (ro.MAUTIC_CLIENT_ID && ro.MAUTIC_CLIENT_ID === rw.MAUTIC_CLIENT_ID)
    p.push("MAUTIC_RO_CLIENT_ID が MAUTIC_CLIENT_ID と同じ。mautic-prod-ro は別の API 認証情報にする（上流の権限はどちらも管理者だが、片方を失効・入れ替えしても、もう片方を止めないため）");
  if (rw.MAUTIC_CLIENT_ID && rw.MAUTIC_CLIENT_ID === ctx.conf.MAUTIC_SETUP_CLIENT_ID)
    p.push("MAUTIC_CLIENT_ID が初期設定用の MAUTIC_SETUP_CLIENT_ID と同じ。初期設定用は終わったら消すので、エージェント用は別に作る");
  if (files["chatwoot-prod"].CHATWOOT_API_ACCESS_TOKEN && files["chatwoot-prod"].CHATWOOT_API_ACCESS_TOKEN === ctx.conf.CHATWOOT_ADMIN_TOKEN)
    p.push("CHATWOOT_AGENT_TOKEN が CHATWOOT_ADMIN_TOKEN と同じ。エージェント専用ユーザー〈担当者の権限〉のトークンにする（ADR-17。操作の主体と権限を分ける）");
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
  // chatwoot-prod と同じ扱い（担当者の権限でなければ失敗。ADR-17）
  if (membership.role !== "agent") throw new Error(`このトークンのユーザーは担当者（agent）ではない（role=${membership.role}）。エージェント専用ユーザー〈担当者の権限〉で発行し直す（ADR-17）`);
  return membership.role;
}

async function verifyMautic(ctx, label, f) {
  const res = await ctx.http(`${label} のトークン取得`, `${f.MAUTIC_BASE_URL}/oauth/v2/token`, {
    method: "POST",
    form: { grant_type: "client_credentials", client_id: f.MAUTIC_CLIENT_ID, client_secret: f.MAUTIC_CLIENT_SECRET },
  });
  if (!res?.access_token) throw new Error("トークンの応答に access_token が無い（認証情報を管理者が作ったか確かめる。管理者以外が作ると client_credentials が付かない）");
  await ctx.http(`${label} の API の確認`, `${f.MAUTIC_BASE_URL}/api/contacts?limit=1`, { headers: { Authorization: `Bearer ${res.access_token}` } });
}

/**
 * MCP（Streamable HTTP）の initialize → notifications/initialized → tools/list（nextCursor を辿る）→ セッションの終了。ツール名の配列を返す。
 * 応答は JSON か SSE。SSE は data 行をイベントごとにつなぎ、要求の id と同じ応答を選ぶ。
 */
async function mcpToolNames(url, token) {
  const base = { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  let session = null;
  let initialized = false;
  const headers = () => ({ ...base, ...(session ? { "mcp-session-id": session } : {}), ...(initialized ? { "mcp-protocol-version": MCP_PROTOCOL_VERSION } : {}) });
  const send = async (method, body) => {
    try {
      return await fetch(url, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw Object.assign(new Error(`${new URL(url).origin} に接続できない（${e.cause?.code ?? e.message}）`), { status: 0 });
    }
  };
  const messages = (text, contentType) => {
    if (!text) return [];
    if (!contentType.includes("text/event-stream")) return [JSON.parse(text)];
    // SSE: 空行で区切られたイベントごとに data 行をつなぐ
    return text
      .split(/\r?\n\r?\n/)
      .map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n"))
      .filter(Boolean)
      .map((data) => JSON.parse(data));
  };
  const rpc = async (id, method, params) => {
    const res = await send("POST", { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    session = res.headers.get("mcp-session-id") ?? session;
    const reply = messages(await res.text(), res.headers.get("content-type") ?? "").find((m) => m.id === id);
    if (!reply) throw new Error(`${method} の応答が無い`);
    if (reply.error) throw new Error(`${method}: ${reply.error.message ?? "MCP のエラー"}`);
    return reply.result ?? null;
  };
  try {
    await rpc(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "comegin-setup", version: "1" } });
    initialized = true;
    const note = await send("POST", { jsonrpc: "2.0", method: "notifications/initialized" });
    if (!note.ok) throw Object.assign(new Error(`HTTP ${note.status}`), { status: note.status });
    const names = [];
    let cursor;
    for (let id = 2; id < 52; id++) {
      const list = await rpc(id, "tools/list", cursor ? { cursor } : undefined);
      names.push(...(list?.tools ?? []).map((t) => t.name));
      cursor = list?.nextCursor;
      if (!cursor) return names;
    }
    throw new Error("tools/list のページが 50 を超えた");
  } finally {
    // セッションを閉じる（サーバーに残さない）。セッションの無いサーバー・閉じられないサーバーは 405 などを返すが、気にしない
    if (session) await send("DELETE").catch(() => {});
  }
}

/** 各 MCP を読み取りだけで確かめる。届かないものは unreachable、失敗は failures に入れて、最後まで確かめる */
async function verifyAll(ctx, files) {
  const results = [];
  const unreachable = [];
  const failures = [];
  const attempt = async (name, fn) => {
    try {
      results.push(`${name}: ${await fn()}`);
    } catch (e) {
      (e.status === 0 ? unreachable : failures).push(`${name}: ${e.message}`);
    }
  };
  await attempt("chatwoot-prod", async () => `認証できた（役割 ${await verifyChatwoot(ctx, files["chatwoot-prod"])}）`);
  await attempt("mautic-prod", async () => (await verifyMautic(ctx, "mautic-prod", files["mautic-prod"]), "トークンを取り、API を読めた"));
  await attempt("mautic-prod-ro", async () => (await verifyMautic(ctx, "mautic-prod-ro", files["mautic-prod-ro"]), "トークンを取り、API を読めた"));
  await attempt("strapi-prod", async () => {
    const names = await mcpToolNames(DEFAULTS.STRAPI_MCP_URL, files["strapi-prod"].STRAPI_PROD_TOKEN);
    const forbidden = names.filter((n) => STRAPI_FORBIDDEN.test(n));
    if (forbidden.length) throw new Error(`トークンの権限が広い。公開・非公開化・削除のツールが出ている（${forbidden.join(", ")}）。Admin トークンを下書きまでの権限で発行し直す（ADR-17）`);
    return `ツール ${names.length} 本（公開・非公開化・削除なし）`;
  });
  await attempt("n8n-prod", async () => {
    const names = await mcpToolNames(DEFAULTS.N8N_MCP_URL, files["n8n-prod"].N8N_PROD_TOKEN);
    const humanOnly = names.filter((n) => N8N_HUMAN_ONLY.test(n));
    if (humanOnly.length)
      ctx.warn(`n8n-prod に人間だけが行う操作のツールが出ている（${humanOnly.join(", ")}）。n8n のトークンでは絞れない。これらを tools に含むエージェント定義は control-plane が起動しない（src/runner/agent.ts の HUMAN_ONLY_PROD_TOOLS。TA-07 の 3.3）`);
    return `ツール ${names.length} 本`;
  });
  return { results, unreachable, failures };
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

/** env ファイルの中身が prod.conf と一致しないキー（ファイル名: キー名。値は出さない） */
function staleKeys(ctx, files) {
  const stale = [];
  for (const [name, values] of Object.entries(files)) {
    const path = envPath(ctx, name);
    if (!existsSync(path)) continue;
    const current = ctx.readEnvFile(path);
    for (const [key, value] of Object.entries(values)) if (value && current[key] !== String(value)) stale.push(`${name}: ${key}`);
  }
  return stale;
}

/** 登録表の stdio の args は CONTROL_MAIN_CHECKOUT から解決される。そこの dist が無い・古いと chatwoot-prod・mautic-prod* は動かない */
function distProblems(ctx) {
  const main = ctx.value("CONTROL_MAIN_CHECKOUT");
  if (!main) return ["CONTROL_MAIN_CHECKOUT が prod.conf に無い（登録表の stdio の args は承認済みの main のチェックアウトから解決される。dev.conf と同じ値を書く）"];
  const p = ["backend/chatwoot-mcp/dist/index.js", "backend/mautic-mcp/dist/index.js"].filter((rel) => !existsSync(join(main, rel))).map((rel) => `${join(main, rel)} が無い`);
  const client = join(main, CHATWOOT_MCP_CLIENT);
  if (existsSync(client) && !readFileSync(client, "utf8").includes("api-access-token"))
    p.push(`${client} がアンダースコアのヘッダー（api_access_token）で送る古い版。本番の ALB に捨てられて 401 になる。main を最新にして、そこで pnpm install && pnpm build し直す`);
  return p;
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
  for (const p of shapeProblems(ctx, files)) mark(false, "", p);
  for (const name of Object.keys(files)) {
    const path = envPath(ctx, name);
    if (!existsSync(path)) mark(false, "", `${path} がまだ無い`);
    else mark((statSync(path).mode & 0o077) === 0, `${name}.env あり（600 系）`, `${path} がほかのユーザーにも読める（chmod 600）`);
  }
  if (Object.keys(files).some((name) => existsSync(envPath(ctx, name)))) {
    const stale = staleKeys(ctx, files);
    mark(stale.length === 0, "env ファイルの中身は prod.conf と一致", `env ファイルの中身が prod.conf と違う（apply で書き直す）: ${stale.join("、")}`);
  }
  for (const m of distProblems(ctx)) mark(false, "", m);
  if (missing.length === 0) {
    const { results, unreachable, failures } = await verifyAll(ctx, files);
    notes.push(...results);
    for (const u of unreachable) mark(false, "", `届かない: ${u}`);
    for (const f of failures) mark(false, "", f);
  }
  return { ok, notes };
}

export async function apply(ctx) {
  const { files, missing } = plan(ctx);
  if (missing.length) {
    ctx.manual("prod-values", "本番の MCP のトークンと API 認証情報を発行して prod.conf に書く", [
      "発行の手順は setup/manual-steps.md の「本番の MCP」（8.2）。Chatwoot・Strapi・n8n・PostHog はエージェント専用のアカウントで発行する（人間の管理者のトークンを使わない。ADR-17）。Mautic の API 認証情報は管理者が作る（上流の権限は管理者になる。絞るのは ACCESS_LEVEL とツールの許可リスト）",
      `~/.config/comegin/setup/prod.conf に次を書く（chmod 600）: ${missing.join("、")}`,
      `URL の既定（CHATWOOT_BASE_URL=${DEFAULTS.CHATWOOT_BASE_URL}・MAUTIC_BASE_URL=${DEFAULTS.MAUTIC_BASE_URL}）と違うときだけ、そのキーも書く`,
      "同じコマンドを実行し直す",
    ]);
  }
  const problems = shapeProblems(ctx, files);
  if (problems.length) throw new Error(`本番の MCP の値に問題がある: ${problems.join("／")}`);

  // 書く前に確かめる（誤った値のファイルを置かない）。オンプレの Strapi・n8n が止まっていて届かないものは、書いてから案内する
  const { results, unreachable, failures } = await verifyAll(ctx, files);
  for (const r of results) ctx.log(r);
  if (failures.length) throw new Error(`本番の MCP の確認に失敗した（env ファイルは書いていない）: ${failures.join("／")}`);
  const written = writeAll(ctx, files);
  ctx.log(`~/.config/comegin/mcp/ に書いた（600）: ${written.join("、")}`);

  const dist = distProblems(ctx);
  if (unreachable.length || dist.length) {
    ctx.manual("finish", "本番の MCP の準備の残り", [
      ...unreachable.map((u) => `届かなかったので未確認: ${u}。オンプレの本番（onprem モジュール）を起動してから、同じコマンドを実行し直す`),
      ...dist.map((d) => `${d}。承認済みの main のチェックアウトで、人が pnpm install && pnpm build する（backend/chatwoot-mcp・backend/mautic-mcp。setup/manual-steps.md の 6 節）`),
    ]);
  }
  ctx.log("登録名 chatwoot-prod・mautic-prod・mautic-prod-ro・strapi-prod・n8n-prod・posthog-prod（ops/mcp-registry.yaml）で使える。PostHog は外部の SaaS なので、キーの形式だけを確かめた");
}
