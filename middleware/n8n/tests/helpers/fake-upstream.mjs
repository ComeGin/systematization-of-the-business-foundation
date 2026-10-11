// provision.mjs のテスト用の偽の上流（n8n の公開 API・内部 API、Mautic、Chatwoot）。global fetch の代わりに vi.stubGlobal("fetch", up.fetch) で差し替える。
// 実際のネットワーク・開発環境のコンテナ（127.0.0.1 のサービス）には届かない: ここに無い URL は例外にする（素通しの経路を作らない）。
// 応答の形は provision.mjs の出典のコメント（n8n 2.39.5 の公開 API、Mautic の /api/hooks、Chatwoot 4.x の webhooks）に合わせた。
// restoreMocks: true のため、ここでは vi.fn を使わず、受けた要求は requests の配列に記録する。

export const N8N = "http://127.0.0.1:5678";
export const MAUTIC = "http://127.0.0.1:8000";
export const CHATWOOT = "http://127.0.0.1:3100";

/** テストで使う秘密値（ログ・エラー文に出ていないことを確かめる） */
export const SECRETS = {
  N8N_API_KEY: "n8n-api-key-0123456789",
  MAUTIC_CLIENT_ID: "mautic-client-id-abc",
  MAUTIC_CLIENT_SECRET: "mautic-client-secret-xyz",
  CHATWOOT_API_ACCESS_TOKEN: "chatwoot-admin-token-123",
  CHATWOOT_N8N_API_TOKEN: "chatwoot-n8n-token-456",
  MAUTIC_ACCESS_TOKEN: "mautic-access-token-789",
  MAUTIC_HOOK_SECRET: "mautic-hook-secret-aaa",
  CHATWOOT_HOOK_SECRET: "chatwoot-hook-secret-bbb",
  AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-ccc",
};

const json = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * @param {{ pageSize?: number }} [opts] pageSize: n8n の一覧を何件ずつ返すか（カーソルでのページ送りを確かめる）
 */
export function createFakeUpstream({ pageSize = 250 } = {}) {
  let seq = 100;
  const nextId = () => String(seq++);
  const state = {
    dataTables: [], // { id, name, columns: [{ name, type }] }
    rows: {}, // tableId → [{ key, value }]
    credentials: [], // { id, name, type, data }
    tags: [], // { id, name }
    workflows: [], // { id, name, nodes, connections, settings, tags, published, isArchived }
    mauticHooks: [], // { id, webhookUrl, triggers, isPublished, secret }
    chatwootHooks: [], // { id, url, subscriptions, secret }
    credentialPatch: 405, // n8n 2.39.5 は公開 API の PATCH /credentials/{id} が 405
    mauticReturnsSecret: true,
    chatwootReturnsSecret: true,
    requests: [], // { method, url, headers, body }
    /** 先に当てる差し替え。match(method, URL) が真なら respond() の Response を返す（例外を投げれば通信失敗） */
    overrides: [],
  };

  const page = (list, u) => {
    const offset = Number(u.searchParams.get("cursor") ?? 0);
    const size = Math.min(Number(u.searchParams.get("limit") ?? 100), pageSize);
    const data = list.slice(offset, offset + size);
    return { data, nextCursor: offset + size < list.length ? String(offset + size) : null };
  };

  function n8nApi(method, u, path, body, headers) {
    if (headers["X-N8N-API-KEY"] !== SECRETS.N8N_API_KEY) return json(401, { message: "unauthorized" });
    let m;
    if (method === "GET" && path === "/workflows") return json(200, page(state.workflows, u));
    if (method === "POST" && path === "/workflows") {
      const wf = { id: nextId(), ...body, published: false, isArchived: false };
      state.workflows.push(wf);
      return json(200, wf);
    }
    if ((m = path.match(/^\/workflows\/([^/]+)$/)) && method === "PUT") {
      const wf = state.workflows.find((w) => w.id === m[1]);
      if (!wf) return json(404, { message: "Not Found" });
      Object.assign(wf, body);
      return json(200, wf);
    }
    if ((m = path.match(/^\/workflows\/([^/]+)\/tags$/)) && method === "PUT") {
      state.workflows.find((w) => w.id === m[1]).tags = body.map((t) => t.id);
      return json(200, body);
    }
    if ((m = path.match(/^\/workflows\/([^/]+)\/publish$/)) && method === "POST") {
      state.workflows.find((w) => w.id === m[1]).published = true;
      return json(200, {});
    }
    if (method === "GET" && path === "/tags") return json(200, page(state.tags, u));
    if (method === "POST" && path === "/tags") {
      const tag = { id: nextId(), name: body.name };
      state.tags.push(tag);
      return json(200, tag);
    }
    if (method === "GET" && path === "/credentials") return json(200, page(state.credentials.map(({ data, ...c }) => c), u));
    if (method === "POST" && path === "/credentials") {
      const cred = { id: nextId(), ...body };
      state.credentials.push(cred);
      return json(200, { id: cred.id, name: cred.name, type: cred.type });
    }
    if ((m = path.match(/^\/credentials\/([^/]+)$/)) && method === "PATCH") {
      if (state.credentialPatch !== 200) return json(state.credentialPatch, { message: "PATCH method not allowed" });
      state.credentials.find((c) => c.id === m[1]).data = body.data;
      return json(200, {});
    }
    if (method === "GET" && path === "/data-tables") return json(200, page(state.dataTables, u));
    if (method === "POST" && path === "/data-tables") {
      const t = { id: nextId(), name: body.name, columns: body.columns };
      state.dataTables.push(t);
      state.rows[t.id] = [];
      return json(200, t);
    }
    if ((m = path.match(/^\/data-tables\/([^/]+)\/columns$/)) && method === "POST") {
      state.dataTables.find((t) => t.id === m[1]).columns.push(body);
      return json(200, body);
    }
    if ((m = path.match(/^\/data-tables\/([^/]+)\/rows\/upsert$/)) && method === "POST") {
      const rows = state.rows[m[1]];
      const key = body.filter.filters[0].value;
      const row = rows.find((r) => r.key === key);
      if (row) Object.assign(row, body.data);
      else rows.push({ ...body.data });
      return json(200, true);
    }
    if ((m = path.match(/^\/data-tables\/([^/]+)\/rows$/))) {
      if (method === "GET") return json(200, page(state.rows[m[1]], u));
      if (method === "POST") {
        state.rows[m[1]].push(...body.data);
        return json(200, body.data.length);
      }
    }
    return null;
  }

  function route(method, u, body, headers) {
    const origin = u.origin;
    const path = u.pathname;
    if (origin === N8N && path.startsWith("/api/v1/")) return n8nApi(method, u, path.slice("/api/v1".length), body, headers);
    if (origin === N8N && method === "PATCH" && /^\/rest\/credentials\/[^/]+$/.test(path)) {
      if (!String(headers.Cookie ?? "").startsWith("n8n-auth=")) return json(401, { message: "Unauthorized" });
      state.credentials.find((c) => c.id === path.split("/").pop()).data = body.data;
      return json(200, { data: {} });
    }
    if (origin === MAUTIC && path === "/oauth/v2/token" && method === "POST") {
      if (body.client_id !== SECRETS.MAUTIC_CLIENT_ID || body.client_secret !== SECRETS.MAUTIC_CLIENT_SECRET) return json(400, { errors: [{ message: "invalid_client" }] });
      return json(200, { access_token: SECRETS.MAUTIC_ACCESS_TOKEN, expires_in: 3600 });
    }
    if (origin === MAUTIC && path.startsWith("/api/hooks")) {
      if (headers.Authorization !== `Bearer ${SECRETS.MAUTIC_ACCESS_TOKEN}`) return json(401, { errors: [{ message: "unauthorized" }] });
      const withSecret = (h) => (state.mauticReturnsSecret ? h : { ...h, secret: undefined });
      if (method === "GET" && path === "/api/hooks") return json(200, { total: state.mauticHooks.length, hooks: Object.fromEntries(state.mauticHooks.map((h) => [h.id, withSecret(h)])) });
      if (method === "POST" && path === "/api/hooks/new") {
        const hook = { id: Number(nextId()), webhookUrl: body.webhookUrl, triggers: body.triggers, isPublished: body.isPublished, secret: SECRETS.MAUTIC_HOOK_SECRET };
        state.mauticHooks.push(hook);
        return json(201, { hook: withSecret(hook) });
      }
      const m = path.match(/^\/api\/hooks\/(\d+)\/edit$/);
      if (m && method === "PATCH") {
        const hook = state.mauticHooks.find((h) => h.id === Number(m[1]));
        Object.assign(hook, body);
        return json(200, { hook: withSecret(hook) });
      }
    }
    if (origin === CHATWOOT && path.startsWith("/api/v1/accounts/1/webhooks")) {
      if (headers.api_access_token !== SECRETS.CHATWOOT_API_ACCESS_TOKEN) return json(401, { error: "You are not authorized to access this page." });
      const withSecret = (h) => (state.chatwootReturnsSecret ? h : { ...h, secret: undefined });
      if (method === "GET" && path === "/api/v1/accounts/1/webhooks") return json(200, { payload: { webhooks: state.chatwootHooks.map(withSecret) } });
      if (method === "POST" && path === "/api/v1/accounts/1/webhooks") {
        const hook = { id: Number(nextId()), url: body.webhook.url, subscriptions: body.webhook.subscriptions, secret: SECRETS.CHATWOOT_HOOK_SECRET };
        state.chatwootHooks.push(hook);
        return json(200, { payload: { webhook: withSecret(hook) } });
      }
      const m = path.match(/^\/api\/v1\/accounts\/1\/webhooks\/(\d+)$/);
      if (m && method === "PATCH") {
        const hook = state.chatwootHooks.find((h) => h.id === Number(m[1]));
        Object.assign(hook, body.webhook);
        return json(200, { payload: { webhook: withSecret(hook) } });
      }
    }
    return null;
  }

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    let body;
    if (typeof init.body === "string") body = headers["Content-Type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
    state.requests.push({ method, url: String(url), headers, body, signal: init.signal });
    for (const o of state.overrides) if (o.match(method, u)) return o.respond(method, u, body);
    const res = route(method, u, body, headers);
    if (!res) throw new Error(`偽の上流に無い要求: ${method} ${url}`);
    return res;
  }

  /** n8n の公開 API への書き込み（GET 以外）だけを、パスで返す */
  const writes = () => state.requests.filter((r) => r.method !== "GET" && !r.url.includes("/oauth/")).map((r) => `${r.method} ${new URL(r.url).pathname}`);
  const opsRows = () => state.rows[state.dataTables.find((t) => t.name === "ops_settings")?.id] ?? [];

  return { fetch, state, writes, opsRows };
}

/** provision の io の代わり。出力を貯める */
export function captureIo() {
  const logs = [];
  const warns = [];
  return { io: { log: (m) => logs.push(m), warn: (m) => warns.push(m) }, logs, warns, text: () => [...logs, ...warns].join("\n") };
}
