// n8n（開発環境。http://127.0.0.1:5678）の設定。setup/lib/core.mjs の契約に従う。
//
// やること: 環境変数ファイル（dev/init-env.sh）→ compose up → 応答待ち → オーナー → 公開 API のキー → MCP のアクセストークン
//          → provision（Data Table・Mautic/Chatwoot の Webhook・資格情報・ワークフローの取り込みと公開）
//
// 確かめた出典（動いているコンテナ n8n-n8n-1〈n8nio/n8n:2.39.5〉の /usr/local/lib/node_modules/n8n/dist 内のソース）:
//   - オーナーの作成: controllers/owner.controller.js（POST /rest/owner/setup。skipAuth）、@n8n/api-types の OwnerSetupRequestDto
//     （email・firstName・lastName・password。パスワードは 8〜64 文字で数字と英大文字を含む）。GET /rest/settings の userManagement.showSetupOnFirstLoad が未作成の印
//   - ログイン: controllers/auth.controller.js（POST /rest/login。LoginRequestDto の emailOrLdapLoginId・password。cookie n8n-auth）。
//     browser-id ヘッダーを送らなければ JWT に browserId が入らず、cookie だけで /rest が使える（auth/auth.service.js の validateBrowserId）
//   - 公開 API のキー: controllers/api-keys.controller.js（GET/POST /rest/api-keys、POST /:id/rotate、GET /scopes）。
//     CreateApiKeyRequestDto は label・scopes・expiresAt（秒の数値か null）。作成と rotate の応答の rawApiKey だけが生の値。
//     一覧は { items: [{ id, label, scopes, ... }] }（services/public-api-key.service.js）。オーナーのスコープは @n8n/permissions の OWNER_API_KEY_SCOPES
//   - MCP: modules/mcp/mcp.settings.controller.js（PATCH /rest/mcp/settings { mcpAccessEnabled }、GET /rest/mcp/api-key、POST /rest/mcp/api-key/rotate）、
//     modules/mcp/mcp-api-key.service.js（鍵は作成時と rotate のときだけ生の値。既にあると一覧は伏せ字）、modules/mcp/mcp.controller.js（POST /mcp-server/http）。
//     設定が環境変数で管理されているとき（mcpManagedByEnv）は PATCH が 403
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROVISION_SCOPES, buildConf, provision } from "../provision/provision.mjs";

export const meta = { id: "n8n", title: "n8n（ワークフロー基盤）", targets: ["dev"], after: ["host-relay", "chatwoot", "mautic"] };

const DIR = "middleware/n8n";
const BASE = "http://127.0.0.1:5678";
const API_KEY_LABEL = "setup-provision";
const MCP_URL = `${BASE}/mcp-server/http`;

// provision が読む設定のうち、状態から渡さないもの。設定（dev.conf）に同じ名前で書いてあれば、そのまま渡す
const PASS_THROUGH = [
  "N8N_BASE_URL", "MAUTIC_API_URL", "MAUTIC_URL_FROM_N8N", "MAUTIC_WEBHOOK_TARGET", "CHATWOOT_API_URL", "CHATWOOT_URL_FROM_N8N", "CHATWOOT_N8N_API_TOKEN", "CHATWOOT_WEBHOOK_TARGET",
  "SMTP_HOST", "SMTP_PORT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "SNS_TOPIC_ARN_LEAD", "SNS_TOPIC_ARN_OPS",
];

/** n8n のパスワードの規則（8〜64 文字・数字と英大文字を含む）を満たす値を作る */
function strongPassword(ctx) {
  for (;;) {
    const p = ctx.randomSecret(18);
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p;
  }
}

async function healthy(ctx) {
  try {
    const res = await ctx.http("n8n", `${BASE}/healthz`, { raw: true, timeoutMs: 5_000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function apiKeyWorks(ctx, key) {
  if (!key) return false;
  try {
    await ctx.http("n8n", `${BASE}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": key }, timeoutMs: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/** MCP のアクセストークンが通るか（initialize だけを送る。何も変えない） */
async function mcpWorks(ctx, token) {
  if (!token) return false;
  try {
    const res = await ctx.http("n8n（MCP）", MCP_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "setup", version: "0" } } },
      raw: true,
      timeoutMs: 8_000,
    });
    res.body?.cancel().catch(() => {});
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function check(ctx) {
  const notes = [];
  const up = await healthy(ctx);
  notes.push(`GET /healthz: ${up ? "200" : "応答なし（apply で compose up）"}`);
  if (!up) return { ok: false, notes };
  const settings = await ctx.http("n8n", `${BASE}/rest/settings`).catch(() => null);
  const ownerOk = settings && settings.data?.userManagement?.showSetupOnFirstLoad === false;
  notes.push(`オーナー: ${ownerOk ? "作成済み" : "まだ（apply で作る）"}`);
  const apiOk = await apiKeyWorks(ctx, ctx.value("N8N_API_KEY"));
  notes.push(`N8N_API_KEY: ${apiOk ? "使える" : ctx.value("N8N_API_KEY") ? "使えない（apply で作り直す）" : "まだ"}`);
  const mcpOk = await mcpWorks(ctx, ctx.value("N8N_DEV_TOKEN"));
  notes.push(`N8N_DEV_TOKEN（MCP）: ${mcpOk ? "使える" : ctx.value("N8N_DEV_TOKEN") ? "使えない（apply で作り直す）" : "まだ"}／n8n-dev.env: ${existsSync(join(ctx.CONFIG_DIR, "mcp/n8n-dev.env")) ? "ある" : "まだ"}`);
  let flowsOk = false;
  if (apiOk) {
    const list = await ctx.http("n8n", `${BASE}/api/v1/workflows?limit=250`, { headers: { "X-N8N-API-KEY": ctx.value("N8N_API_KEY") } }).catch(() => null);
    const names = (list?.data ?? []).filter((w) => !w.isArchived).map((w) => w.name);
    // 先頭が I-xx の 5 本と、定期実行の 3 本（名前の先頭の一部で見る）
    const want = ["I-21", "I-19", "I-11", "I-12", "I-18", "週次 問い合わせの棚卸し", "n8n スケジュール実行のハートビート", "運用監視"];
    const have = want.filter((p) => names.some((n) => n.startsWith(p)));
    flowsOk = have.length === want.length;
    notes.push(`ワークフロー: ${have.length}/${want.length} 本が取り込み済み（${want.filter((p) => !have.includes(p)).join(", ") || "全部"}${have.length === want.length ? "" : " が無い"}）`);
  }
  return { ok: ownerOk && apiOk && mcpOk && flowsOk && existsSync(join(ctx.CONFIG_DIR, "mcp/n8n-dev.env")), notes };
}

export async function apply(ctx) {
  const dir = join(ctx.W, DIR);

  // 1. 環境変数ファイルと起動
  await ctx.run("bash", ["dev/init-env.sh"], { cwd: dir });
  ctx.log("dev/init-env.sh: 済み");
  await ctx.run("docker", ["compose", "up", "-d"], { cwd: dir });
  if (!(await ctx.waitForHttp(`${BASE}/healthz`, { timeoutMs: 240_000 })) || !(await healthy(ctx))) {
    throw new Error(`n8n が ${BASE}/healthz に応答しない。cd ${DIR} && docker compose logs n8n を見る`);
  }
  ctx.log("n8n が応答している");

  // 2. 公開 API のキーと MCP のトークン（状態か設定に値があって通るなら、ログインしない）
  let apiKey = ctx.value("N8N_API_KEY");
  let mcpToken = ctx.value("N8N_DEV_TOKEN");
  const apiOk = await apiKeyWorks(ctx, apiKey);
  const mcpOk = await mcpWorks(ctx, mcpToken);
  if (!apiOk || !mcpOk) {
    const session = await openSession(ctx);
    if (!apiOk) apiKey = await ensureApiKey(ctx, session);
    if (!mcpOk) mcpToken = await ensureMcpToken(ctx, session);
  }
  ctx.state.set("N8N_API_KEY", apiKey, { secret: true });
  ctx.state.set("N8N_DEV_TOKEN", mcpToken, { secret: true });
  ctx.log(`N8N_API_KEY と N8N_DEV_TOKEN: ${apiOk && mcpOk ? "使える状態" : "用意した"}`);

  // MCP の env ファイル（ops/mcp-registry.yaml の n8n が読む）
  ctx.writeEnvFile(join(ctx.CONFIG_DIR, "mcp", "n8n-dev.env"), { N8N_DEV_TOKEN: mcpToken }, { onlyIfEmpty: false });
  ctx.log("~/.config/comegin/mcp/n8n-dev.env に書いた（600）");

  // 3. provision（Mautic の API 資格情報と、Chatwoot の管理者のトークンが要る。前のモジュールが作る）
  const mauticId = ctx.value("MAUTIC_CLIENT_ID");
  const mauticSecret = ctx.value("MAUTIC_CLIENT_SECRET");
  if (!mauticId || !mauticSecret) {
    ctx.manual("mautic-api-credentials", "Mautic の API 資格情報（OAuth 2 のクライアント）を設定に書く", [
      "Mautic（http://127.0.0.1:8000）に管理者でログインし、右上の歯車 → Configuration → API Settings タブで「API enabled?」を Yes にして Save & Close（有効なら飛ばす）",
      "右上の歯車 → API Credentials → New で、Authorization Protocol は OAuth 2、Name は comegin-dev、Redirect URI は http://localhost にして Save & Close",
      "一覧の Public Key（＝クライアント ID）と Secret Key を ~/.config/comegin/setup/dev.conf に MAUTIC_CLIENT_ID=… と MAUTIC_CLIENT_SECRET=… として書く（chmod 600）",
      "同じコマンドを実行し直す（手順は setup/manual-steps.md の 2 節にもある）",
    ]);
  }
  const values = {
    N8N_API_KEY: apiKey,
    MAUTIC_CLIENT_ID: mauticId,
    MAUTIC_CLIENT_SECRET: mauticSecret,
    CHATWOOT_API_ACCESS_TOKEN: ctx.require("CHATWOOT_ADMIN_TOKEN", "chatwoot モジュールが作る値。先に chatwoot を実行する（node setup/setup.mjs --target dev --only chatwoot）"),
    CHATWOOT_ACCOUNT_ID: ctx.require("CHATWOOT_ACCOUNT_ID", "chatwoot モジュールが作る値。先に chatwoot を実行する"),
  };
  for (const k of PASS_THROUGH) if (ctx.conf[k]) values[k] = ctx.conf[k];
  const publish = ctx.conf.N8N_PUBLISH_PARENTS === "true";
  // 資格情報の更新が公開 API で 405 になったとき（n8n 2.39.5）だけ、オーナーでログインして内部の API を使う。ログインは 1 回だけ
  let session;
  const restSession = async () => (session ??= await openSession(ctx));
  await provision({ target: "dev", conf: buildConf("dev", values), publish, restSession, io: { log: (m) => ctx.log(m.replace(/^\n/, "")), warn: ctx.warn } });
  if (!publish) ctx.log("親（I-11・I-12）は未公開。確かめるときは dev.conf に N8N_PUBLISH_PARENTS=true を書いて再実行する（終わったら n8n の画面で Unpublish）");
}

// ---------------------------------------------------------------------------
// オーナーとログイン
// ---------------------------------------------------------------------------

/** オーナーを（未作成なら）作り、ログインして cookie を返す */
async function openSession(ctx) {
  const email = ctx.value("N8N_OWNER_EMAIL") || ctx.require("ADMIN_EMAIL");
  const settings = await ctx.http("n8n", `${BASE}/rest/settings`);
  if (settings?.data?.userManagement?.showSetupOnFirstLoad) {
    const password = strongPassword(ctx);
    await ctx.http("n8n（オーナーの作成）", `${BASE}/rest/owner/setup`, { method: "POST", json: { email, firstName: "Admin", lastName: "ComeGin", password } });
    ctx.state.set("N8N_OWNER_PASSWORD", password, { secret: true });
    ctx.log(`オーナーを作った（${email}。パスワードは --show N8N_OWNER_PASSWORD）`);
  } else ctx.log("オーナーは作成済み");

  const password = ctx.value("N8N_OWNER_PASSWORD");
  if (!password) {
    ctx.manual("owner-password", "既にある n8n のオーナーのパスワードを設定に書く", [
      `~/.config/comegin/setup/dev.conf に N8N_OWNER_PASSWORD=<オーナーのパスワード> を書く（メールが ADMIN_EMAIL と違うなら N8N_OWNER_EMAIL=<メール> も）`,
      "忘れたとき: 開発の n8n は SMTP が無いのでメールでの再設定はできない。最後の手段は docker compose exec n8n n8n user-management:reset（全ユーザーを消して最初の状態に戻す。https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line）→ 再実行するとスクリプトがオーナーを作り直す",
      "同じコマンドを実行し直す",
    ]);
  }
  const res = await ctx.http("n8n（ログイン）", `${BASE}/rest/login`, { method: "POST", json: { emailOrLdapLoginId: email, password }, raw: true });
  await res.text();
  if (res.status === 401 || res.status === 400) {
    ctx.manual("owner-login", "n8n のオーナーでログインできない", [
      `設定（~/.config/comegin/setup/dev.conf）か状態の N8N_OWNER_PASSWORD が、${email} の今のパスワードと合っていない`,
      "n8n の画面で今のパスワードを確かめるか、変えてから、設定の N8N_OWNER_PASSWORD を直す（状態に同名の値があるなら、設定のほうが優先される）",
      "同じコマンドを実行し直す",
    ]);
  }
  if (!res.ok) throw new Error(`n8n（ログイン）: HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("n8n-auth="));
  if (!cookie) throw new Error("n8n（ログイン）: 応答に認証 cookie が無い");
  return cookie;
}

const rest = async (ctx, cookie, label, path, opts = {}) => {
  const body = await ctx.http(`n8n（${label}）`, `${BASE}/rest${path}`, { ...opts, headers: { Cookie: cookie } });
  return body?.data ?? body;
};

// ---------------------------------------------------------------------------
// 公開 API のキー
// ---------------------------------------------------------------------------

async function ensureApiKey(ctx, cookie) {
  const allowed = new Set(await rest(ctx, cookie, "API キーのスコープ", "/api-keys/scopes"));
  const lack = PROVISION_SCOPES.filter((s) => !allowed.has(s));
  if (lack.length) throw new Error(`n8n の API キーで使えないスコープがある: ${lack.join(", ")}（provision.mjs の PROVISION_SCOPES を n8n の版に合わせる）`);

  const list = await rest(ctx, cookie, "API キーの一覧", "/api-keys?ownership=mine");
  const found = (list?.items ?? []).find((k) => k.label === API_KEY_LABEL);
  if (found) {
    // 値は作成時にしか返らない。状態に無い・通らないなら、スコープをそろえて rotate（作り直し）する
    await rest(ctx, cookie, "API キーの更新", `/api-keys/${found.id}`, { method: "PATCH", json: { label: API_KEY_LABEL, scopes: PROVISION_SCOPES } });
    const rotated = await rest(ctx, cookie, "API キーの rotate", `/api-keys/${found.id}/rotate`, { method: "POST" });
    if (!rotated?.rawApiKey) throw new Error("n8n: API キーを rotate したが、応答に値が無い");
    ctx.log(`API キー（${API_KEY_LABEL}）は既にあったが値が分からないので作り直した`);
    return rotated.rawApiKey;
  }
  const created = await rest(ctx, cookie, "API キーの作成", "/api-keys", { method: "POST", json: { label: API_KEY_LABEL, scopes: PROVISION_SCOPES, expiresAt: null } });
  if (!created?.rawApiKey) throw new Error("n8n: API キーを作ったが、応答に値が無い（公開 API が無効になっていないか確かめる）");
  return created.rawApiKey;
}

// ---------------------------------------------------------------------------
// MCP のアクセストークン（インスタンス内蔵の MCP サーバー）
// ---------------------------------------------------------------------------

async function ensureMcpToken(ctx, cookie) {
  try {
    await rest(ctx, cookie, "MCP の有効化", "/mcp/settings", { method: "PATCH", json: { mcpAccessEnabled: true } });
  } catch (e) {
    if (e.status === 403) {
      ctx.manual("mcp-managed-by-env", "n8n の MCP のアクセスが環境変数で管理されている", [
        "n8n の compose の環境変数で MCP の設定が固定されているため、API では有効にできない（PATCH /rest/mcp/settings が 403）",
        "n8n の画面で Settings → Instance-level MCP が有効か確かめ、無効なら環境変数の指定を外すか、有効にしてから、同じコマンドを実行し直す",
      ]);
    }
    throw e;
  }
  const current = await rest(ctx, cookie, "MCP のトークン", "/mcp/api-key");
  if (current?.apiKey && !/^\*/.test(current.apiKey)) return current.apiKey; // 作ったばかりのときだけ生の値が返る

  // 既にあるトークンの値は、n8n からは読めない。作り直すと、そのトークンを使っている MCP クライアントが使えなくなる
  const ours = ctx.state.has("N8N_DEV_TOKEN");
  if (!ours && ctx.conf.N8N_MCP_ROTATE !== "true") {
    ctx.manual("mcp-token", "n8n の MCP のアクセストークンは作成済みで、値を読めない", [
      "n8n の画面はトークンを作ったときにしか表示しない（\"you won't be able to see it again\"）。作ったときに控えた値（Claude Code の n8n の MCP の接続設定に入れた値など）があれば、~/.config/comegin/setup/dev.conf に N8N_DEV_TOKEN=… として書く",
      "控えが無い、または作り直してよいとき: dev.conf に N8N_MCP_ROTATE=true を書く（今のトークンを使っている MCP クライアントは切れる。新しい値は ~/.config/comegin/mcp/n8n-dev.env に入るので、クライアント側の設定をそれに合わせる）",
      "同じコマンドを実行し直す",
    ]);
  }
  const rotated = await rest(ctx, cookie, "MCP のトークンの rotate", "/mcp/api-key/rotate", { method: "POST" });
  if (!rotated?.apiKey || /^\*/.test(rotated.apiKey)) throw new Error("n8n: MCP のトークンを rotate したが、応答に生の値が無い");
  ctx.log("MCP のアクセストークンを作り直した");
  return rotated.apiKey;
}
