#!/usr/bin/env node
// n8n のワークフロー（../workflows/*.json）を、Data Table・資格情報・Mautic と Chatwoot の Webhook ごと、まとめて用意する。
//
//   node provision.mjs --target dev            # 開発環境（127.0.0.1:5678）
//   node provision.mjs --target prod           # 本番（オンプレ。127.0.0.1:5679。ADR-21）
//   node provision.mjs --target dev --check    # 設定と接続だけを確かめる（何も作らない）
//   node provision.mjs --target dev --publish  # 親（I-11・I-12）も公開する（本番の公開は R1 の判断）
//
// 何度実行しても同じ結果になる（名前で探して、あれば更新、無ければ作成）。途中で失敗したら、直してもう一度実行すればよい。
// 秘密値（API キー・シークレット）は画面にもログにも出さない。Mautic・Chatwoot が作った Webhook のシークレットは、
// このスクリプトの中だけを通って n8n の資格情報に入る。
//
// 依存パッケージは無い（Node 22 以上の fetch だけを使う）。設定は README.md と provision.conf.example を見る。
//
// 関数としても呼べる（setup/setup.mjs の n8n モジュールが使う）: `import { provision, buildConf } from "./provision.mjs"`。
// 関数として呼ぶときは process.exit しない（失敗は Error を投げる）。出力は呼び出し側の log・warn に渡る。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(HERE, "../workflows");
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 何を作るか（README.md と GUIDE.md の表と同じ。変えるときは両方を直す）
// ---------------------------------------------------------------------------

const DATA_TABLES = [
  { name: "dedup_mautic", columns: [["dedupKey", "string"], ["contactId", "number"], ["eventType", "string"], ["timestampSec", "number"]] },
  { name: "dedup_chatwoot", columns: [["dedupKey", "string"], ["displayId", "number"], ["messageId", "string"]] },
  { name: "ops_settings", columns: [["key", "string"], ["value", "string"]] },
  { name: "monitor_state", columns: [["checkId", "string"], ["state", "string"]] },
  {
    name: "contact_link",
    columns: [["chatwootContactId", "number"], ["displayId", "number"], ["status", "string"], ["mauticContactId", "number"], ["matchCount", "number"], ["checkedAt", "string"]],
  },
];

// 取り込む順番（子 → 親）。publish: "always" は子（親から呼ばれるため常に公開する）、"flag" は --publish のときだけ、"never" は公開しない
const WORKFLOWS = [
  { file: "I-21-sns-notify.json", publish: "always", tags: ["subworkflow", "notification"] },
  { file: "I-19-email-match.json", publish: "always", tags: ["subworkflow", "matching"] },
  { file: "I-11-mautic-webhook-dedup.json", publish: "flag", tags: ["webhook"] },
  { file: "I-12-chatwoot-webhook-dedup.json", publish: "flag", tags: ["webhook"] },
  { file: "I-18-posthog-writeback.json", publish: "never", tags: ["blocked"] },
];

const CRED = {
  mauticSig: "Mautic Webhook 署名鍵（Crypto）",
  chatwootSig: "Chatwoot Webhook 署名鍵（Crypto）",
  mauticApi: "Mautic API（client_credentials）",
  smtp: "MailHog SMTP（開発）",
  aws: "AWS SNS 発行（アクセスキー）",
};

// Mautic の Webhook のイベント（README の I-11 の「トリガー」と同じ）
const MAUTIC_TRIGGERS = ["mautic.lead_post_save_new", "mautic.lead_post_save_update", "mautic.lead_points_change", "mautic.lead_list_change", "mautic.form_on_submit"];
const MAUTIC_HOOK_NAME = "n8n I-11";
// Chatwoot の Webhook のイベント（README の I-12 の「トリガー」と同じ）
const CHATWOOT_SUBSCRIPTIONS = ["conversation_created", "message_created"];
const CHATWOOT_HOOK_NAME = "n8n I-12";

const DEFAULTS = {
  dev: {
    N8N_BASE_URL: "http://127.0.0.1:5678",
    MAUTIC_API_URL: "http://127.0.0.1:8000",
    MAUTIC_URL_FROM_N8N: "http://host.docker.internal:8000",
    MAUTIC_WEBHOOK_TARGET: "http://127.0.0.1:5678/webhook/mautic-event",
    CHATWOOT_API_URL: "http://127.0.0.1:3100",
    CHATWOOT_WEBHOOK_TARGET: "http://host.docker.internal:5678/webhook/chatwoot-event",
    SMTP_HOST: "host.docker.internal",
    SMTP_PORT: "1025",
  },
  prod: {
    N8N_BASE_URL: "http://127.0.0.1:5679",
    MAUTIC_API_URL: "https://mkt.comegin.com",
    MAUTIC_URL_FROM_N8N: "https://mkt.comegin.com",
    MAUTIC_WEBHOOK_TARGET: "http://10.99.0.2:5680/webhook/mautic-event",
    CHATWOOT_API_URL: "https://chat.comegin.com",
    CHATWOOT_WEBHOOK_TARGET: "http://10.99.0.2:5680/webhook/chatwoot-event",
    AWS_REGION: "ap-northeast-1",
  },
};

const REQUIRED = {
  common: ["N8N_BASE_URL", "N8N_API_KEY", "MAUTIC_API_URL", "MAUTIC_CLIENT_ID", "MAUTIC_CLIENT_SECRET", "MAUTIC_URL_FROM_N8N", "MAUTIC_WEBHOOK_TARGET", "CHATWOOT_API_URL", "CHATWOOT_ACCOUNT_ID", "CHATWOOT_API_ACCESS_TOKEN", "CHATWOOT_WEBHOOK_TARGET"],
  dev: ["SMTP_HOST", "SMTP_PORT"],
  prod: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SNS_TOPIC_ARN_LEAD", "SNS_TOPIC_ARN_OPS"],
};

/**
 * このスクリプトが n8n の公開 API（/api/v1）で使う操作に必要な API キーのスコープ（n8n 2.39.5 の @n8n/permissions の OWNER_API_KEY_SCOPES の名前）。
 * setup の n8n モジュールが API キーを作るときに使う。公開 API を増やしたら、ここも足す。
 */
export const PROVISION_SCOPES = [
  "workflow:create", "workflow:read", "workflow:update", "workflow:list", "workflow:activate", "workflow:deactivate",
  "workflowTags:update", "workflowTags:list", "tag:create", "tag:read", "tag:update", "tag:list",
  "credential:create", "credential:update", "credential:list",
  "dataTable:create", "dataTable:read", "dataTable:update", "dataTable:list",
  "dataTableColumn:create", "dataTableColumn:read", "dataTableColumn:update",
  "dataTableRow:create", "dataTableRow:read", "dataTableRow:update", "dataTableRow:upsert",
];

// ---------------------------------------------------------------------------
// 引数と設定
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { target: null, config: null, check: false, publish: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") args.target = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--publish") args.publish = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else fail(`不明な引数: ${a}（--help を参照）`);
  }
  return args;
}

const HELP = `n8n のワークフローを、Data Table・資格情報・Mautic と Chatwoot の Webhook ごとまとめて用意する。

使い方:
  node provision.mjs --target <dev|prod> [--config <path>] [--check] [--publish]

  --target   dev（開発環境 127.0.0.1:5678）か prod（本番。オンプレ 127.0.0.1:5679）
  --config   設定ファイル（既定 ~/.config/comegin/n8n-provision/<target>.conf）
  --check    設定と接続だけを確かめる（何も作らない）
  --publish  親（I-11・I-12）も公開する。子（I-21・I-19）は常に公開する。本番の公開は R1 の判断

詳しくは README.md。`;

function loadConfig(target, path) {
  const file = path ?? join(homedir(), ".config/comegin/n8n-provision", `${target}.conf`);
  let text;
  try {
    const st = statSync(file);
    if ((st.mode & 0o077) !== 0) warn(`${file} はほかのユーザーも読める権限になっている。chmod 600 を推奨`);
    text = readFileSync(file, "utf8");
  } catch {
    fail(`設定ファイルを読めない: ${file}（provision.conf.example を写して作る。README.md）`);
  }
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, eq).trim()] = value;
  }
  return { conf: buildConf(target, values), file };
}

/**
 * 設定の値（provision.conf.example のキー）に、--target ごとの既定値を足して検証する。値が空のキーは既定値のまま。
 * 足りない必須項目があれば Error（値は出さない）。setup/setup.mjs からは、状態と設定から組んだ値を渡す。
 */
export function buildConf(target, values) {
  if (!DEFAULTS[target]) throw new Error(`target は dev か prod: ${target}`);
  const conf = { ...DEFAULTS[target] };
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== "") conf[k] = String(v);
  const missing = [...REQUIRED.common, ...REQUIRED[target]].filter((k) => !conf[k]);
  if (missing.length) fail(`設定に足りない項目がある（値は表示しない）: ${missing.join(", ")}`);
  for (const k of Object.keys(conf)) if (/_URL$|_TARGET$/.test(k)) conf[k] = conf[k].replace(/\/+$/, "");
  return conf;
}

// ---------------------------------------------------------------------------
// 出力（秘密値を出さない）
// ---------------------------------------------------------------------------

// 出力先。CLI は標準出力・標準エラー、関数として呼ぶときは provision() の io で差し替える
let io = { log: (m) => console.log(m), warn: (m) => console.error(`  ! ${m}`) };
function log(msg) {
  io.log(msg);
}
function warn(msg) {
  io.warn(msg);
}
/** 失敗は Error を投げる（CLI の main が受けて表示し、exit 1 にする） */
function fail(msg) {
  throw new Error(msg);
}
function step(title) {
  io.log(`\n■ ${title}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function http(label, url, { method = "GET", headers = {}, json, form } = {}) {
  const init = { method, headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const err = new Error(`${label}: ${new URL(url).origin} に接続できない（${e.name === "TimeoutError" ? "タイムアウト" : e.cause?.code ?? e.message}）`);
    err.status = 0;
    throw err;
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // 応答の本文にはシークレットが入りうるので、エラーの説明（message）だけを出す
    const detail = body?.message ?? body?.error?.message ?? body?.errors?.[0]?.message ?? body?.error ?? "";
    const err = new Error(`${label}: HTTP ${res.status}${detail ? `（${String(detail).slice(0, 300)}）` : ""}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// n8n の公開 API
// ---------------------------------------------------------------------------

function n8n(conf) {
  const base = `${conf.N8N_BASE_URL}/api/v1`;
  const headers = { "X-N8N-API-KEY": conf.N8N_API_KEY };
  const call = (label, path, opts = {}) => http(`n8n ${label}`, `${base}${path}`, { ...opts, headers });
  const listAll = async (label, path) => {
    const out = [];
    let cursor;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await call(label, `${path}${sep}limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...(page?.data ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return out;
  };
  return { call, listAll };
}

async function ensureDataTables(api, conf, target) {
  step("Data Table");
  const existing = await api.listAll("Data Table の一覧", "/data-tables");
  for (const def of DATA_TABLES) {
    let table = existing.find((t) => t.name === def.name);
    if (!table) {
      table = await api.call(`Data Table ${def.name} の作成`, "/data-tables", {
        method: "POST",
        json: { name: def.name, columns: def.columns.map(([name, type]) => ({ name, type })) },
      });
      log(`  ${def.name}: 作成した`);
    } else {
      const have = new Set((table.columns ?? []).map((c) => c.name));
      const lack = def.columns.filter(([name]) => !have.has(name));
      for (const [name, type] of lack) {
        await api.call(`Data Table ${def.name} の列 ${name} の追加`, `/data-tables/${table.id}/columns`, { method: "POST", json: { name, type } });
      }
      log(`  ${def.name}: ${lack.length ? `列を ${lack.length} つ足した` : "そのまま"}`);
    }
    def.id = table.id;
  }

  const settings = target === "dev"
    ? { notifyBackend: "mailhog", mauticBaseUrl: conf.MAUTIC_URL_FROM_N8N }
    : { notifyBackend: "sns", mauticBaseUrl: conf.MAUTIC_URL_FROM_N8N, snsTopicArnLead: conf.SNS_TOPIC_ARN_LEAD, snsTopicArnOps: conf.SNS_TOPIC_ARN_OPS };
  const opsId = DATA_TABLES.find((t) => t.name === "ops_settings").id;
  for (const [key, value] of Object.entries(settings)) {
    await api.call(`ops_settings の ${key}`, `/data-tables/${opsId}/rows/upsert`, {
      method: "POST",
      json: { filter: { type: "and", filters: [{ columnName: "key", condition: "eq", value: key }] }, data: { key, value } },
    });
  }
  log(`  ops_settings: ${Object.keys(settings).join("・")} を設定した`);
}

/**
 * 既にある資格情報の値を入れ直す。n8n 2.39.5 の公開 API は PATCH /credentials/{id} に届かない（405 "PATCH method not allowed"）。
 * 新しい CredentialsPublicController の GET /credentials/:credentialId（テンプレート /credentials/{credentialId}）が、
 * 既存の /credentials/{id}（PATCH・DELETE）と衝突して先に一致するため（dist/public-api/v1/controllers/credentials.public.controller.js）。
 * 405 のときは、画面と同じ内部の API（PATCH /rest/credentials/:id。オーナーの cookie）で入れ直す。cookie が無い（CLI 単体）なら入れ直さずに警告する。
 */
async function updateCredential(api, conf, id, c, restSession) {
  try {
    await api.call(`資格情報 ${c.name} の更新`, `/credentials/${id}`, { method: "PATCH", json: { data: c.data } });
    return "値を入れ直した";
  } catch (e) {
    if (e.status !== 405) throw e;
  }
  if (!restSession) {
    warn(`${c.name}: 値を入れ直せない（n8n の公開 API が資格情報の更新を受け付けない）。既にある値のまま使う。Webhook を作り直したときは n8n の画面で入れ直す`);
    return "そのまま（入れ直せない）";
  }
  const cookie = await restSession();
  await http(`n8n 資格情報 ${c.name} の更新（内部 API）`, `${conf.N8N_BASE_URL}/rest/credentials/${id}`, {
    method: "PATCH",
    headers: { Cookie: cookie },
    json: { name: c.name, type: c.type, data: c.data },
  });
  return "値を入れ直した（内部 API）";
}

async function ensureCredentials(api, conf, target, secrets, restSession) {
  step("資格情報");
  const existing = await api.listAll("資格情報の一覧", "/credentials");
  const wanted = [
    { name: CRED.mauticSig, type: "crypto", data: { hmacSecret: secrets.mautic } },
    { name: CRED.chatwootSig, type: "crypto", data: { hmacSecret: secrets.chatwoot } },
    {
      name: CRED.mauticApi,
      type: "oAuth2Api",
      data: {
        grantType: "clientCredentials",
        accessTokenUrl: `${conf.MAUTIC_URL_FROM_N8N}/oauth/v2/token`,
        clientId: conf.MAUTIC_CLIENT_ID,
        clientSecret: conf.MAUTIC_CLIENT_SECRET,
        scope: "",
        authentication: "body",
      },
    },
  ];
  if (target === "dev") {
    wanted.push({ name: CRED.smtp, type: "smtp", data: { host: conf.SMTP_HOST, port: Number(conf.SMTP_PORT), secure: false, user: "", password: "" } });
    // I-21 の「SNS に発行」は aws の資格情報が必須で、無いと n8n が公開を拒む（2.39.5: "Missing required credential: aws"）。
    // 開発は notifyBackend=smtp で SNS のノードを通らないため、使われないダミーを置く。設定に AWS のキーがあれば、それを使う。
    // 既にある同名の資格情報（人が本物を入れたもの）は、ダミーで上書きしない
    const real = Boolean(conf.AWS_ACCESS_KEY_ID && conf.AWS_SECRET_ACCESS_KEY);
    wanted.push({
      name: CRED.aws,
      type: "aws",
      keepExisting: !real,
      data: real
        ? { region: conf.AWS_REGION || "ap-northeast-1", accessKeyId: conf.AWS_ACCESS_KEY_ID, secretAccessKey: conf.AWS_SECRET_ACCESS_KEY }
        : { region: "ap-northeast-1", accessKeyId: "DEV-PLACEHOLDER-NOT-USED", secretAccessKey: "dev-placeholder-not-used" },
    });
  }
  if (target === "prod") {
    wanted.push({ name: CRED.aws, type: "aws", data: { region: conf.AWS_REGION, accessKeyId: conf.AWS_ACCESS_KEY_ID, secretAccessKey: conf.AWS_SECRET_ACCESS_KEY } });
    // 上の開発のダミーと対称。I-21 の「MailHog に送る」も smtp の資格情報が必須なので、本番では使われないダミーを置く（notifyBackend=sns なら通らない）
    wanted.push({ name: CRED.smtp, type: "smtp", keepExisting: true, data: { host: "127.0.0.1", port: 1025, secure: false, user: "", password: "" } });
  }

  const ids = {};
  for (const { keepExisting, ...c } of wanted) {
    if (!c.data.hmacSecret && c.type === "crypto") fail(`${c.name} に入れるシークレットが空（Webhook の作成に失敗している）`);
    const found = existing.find((e) => e.name === c.name && e.type === c.type);
    if (found && keepExisting) {
      ids[c.name] = found.id;
      log(`  ${c.name}: そのまま（開発では使わない）`);
    } else if (found) {
      ids[c.name] = found.id;
      log(`  ${c.name}: ${await updateCredential(api, conf, found.id, c, restSession)}`);
    } else {
      const created = await api.call(`資格情報 ${c.name} の作成`, "/credentials", { method: "POST", json: c });
      ids[c.name] = created.id;
      log(`  ${c.name}: 作成した`);
    }
  }
  return ids;
}

const WORKFLOW_SETTING_KEYS = ["saveExecutionProgress", "saveManualExecutions", "saveDataErrorExecution", "saveDataSuccessExecution", "executionTimeout", "errorWorkflow", "timezone", "executionOrder", "callerPolicy", "callerIds", "availableInMCP"];

async function ensureTags(api, names) {
  const existing = await api.listAll("タグの一覧", "/tags");
  const ids = {};
  for (const name of names) {
    let tag = existing.find((t) => t.name === name);
    if (!tag) tag = await api.call(`タグ ${name} の作成`, "/tags", { method: "POST", json: { name } });
    ids[name] = tag.id;
  }
  return ids;
}

async function ensureWorkflows(api, credIds, publishParents) {
  step("ワークフロー（子 → 親の順）");
  const existing = (await api.listAll("ワークフローの一覧", "/workflows")).filter((w) => !w.isArchived);
  const tagIds = await ensureTags(api, [...new Set(WORKFLOWS.flatMap((w) => w.tags))]);
  const idByName = {};
  const result = [];

  for (const def of WORKFLOWS) {
    const src = JSON.parse(readFileSync(join(WORKFLOWS_DIR, def.file), "utf8"));
    const nodes = src.nodes.map((node) => {
      const n = structuredClone(node);
      // 資格情報は名前で JSON に入っている。取り込み先の ID を付ける（無いものは外す。ただし必須の資格情報を外すと n8n が公開を拒むので、開発の SNS はダミーを作ってある）
      if (n.credentials) {
        for (const [key, ref] of Object.entries(n.credentials)) {
          const id = credIds[ref?.name];
          if (id) n.credentials[key] = { id, name: ref.name };
          else delete n.credentials[key];
        }
        if (!Object.keys(n.credentials).length) delete n.credentials;
      }
      // 子のワークフローの呼び出し先は、書き出し元の ID のまま。取り込み先の ID に付け替える
      if (n.type === "n8n-nodes-base.executeWorkflow" && n.parameters?.workflowId?.cachedResultName) {
        const name = n.parameters.workflowId.cachedResultName;
        const id = idByName[name];
        if (!id) fail(`${def.file} のノード「${n.name}」の呼び出し先「${name}」が見つからない（子を先に取り込む順番が崩れている）`);
        n.parameters.workflowId = { __rl: true, mode: "id", value: id, cachedResultName: name };
      }
      return n;
    });
    const settings = Object.fromEntries(Object.entries(src.settings ?? {}).filter(([k]) => WORKFLOW_SETTING_KEYS.includes(k)));
    const body = { name: src.name, nodes, connections: src.connections, settings };

    const found = existing.find((w) => w.name === src.name);
    let wf;
    if (found) {
      wf = await api.call(`ワークフロー ${src.name} の更新`, `/workflows/${found.id}`, { method: "PUT", json: body });
    } else {
      wf = await api.call(`ワークフロー ${src.name} の作成`, "/workflows", { method: "POST", json: body });
    }
    idByName[src.name] = wf.id;
    await api.call(`ワークフロー ${src.name} のタグ`, `/workflows/${wf.id}/tags`, { method: "PUT", json: def.tags.map((t) => ({ id: tagIds[t] })) });

    const shouldPublish = def.publish === "always" || (def.publish === "flag" && publishParents);
    if (shouldPublish) await api.call(`ワークフロー ${src.name} の公開`, `/workflows/${wf.id}/publish`, { method: "POST", json: {} });
    result.push({ name: src.name, id: wf.id, action: found ? "更新" : "作成", published: shouldPublish });
    log(`  ${src.name}: ${found ? "更新した" : "作成した"}${shouldPublish ? "・公開した" : "（公開していない）"}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mautic（OAuth2 client_credentials）
// ---------------------------------------------------------------------------

async function mauticToken(conf) {
  const body = await http("Mautic のトークンの取得", `${conf.MAUTIC_API_URL}/oauth/v2/token`, {
    method: "POST",
    form: { grant_type: "client_credentials", client_id: conf.MAUTIC_CLIENT_ID, client_secret: conf.MAUTIC_CLIENT_SECRET },
  });
  if (!body?.access_token) fail("Mautic のトークンが返らなかった（API が有効か、資格情報が正しいかを確かめる）");
  return body.access_token;
}

async function ensureMauticWebhook(conf) {
  step("Mautic の Webhook（I-11）");
  const headers = { Authorization: `Bearer ${await mauticToken(conf)}` };
  const list = await http("Mautic の Webhook の一覧", `${conf.MAUTIC_API_URL}/api/hooks?limit=200`, { headers });
  const hooks = Object.values(list?.hooks ?? {});
  const found = hooks.find((h) => h.webhookUrl === conf.MAUTIC_WEBHOOK_TARGET);
  let hook;
  if (found) {
    const triggers = Array.isArray(found.triggers) ? found.triggers : Object.values(found.triggers ?? {});
    const same = MAUTIC_TRIGGERS.every((t) => triggers.includes(t)) && triggers.length === MAUTIC_TRIGGERS.length;
    if (same && found.isPublished !== false) {
      hook = found;
      log(`  #${found.id}: そのまま（${conf.MAUTIC_WEBHOOK_TARGET}）`);
    } else {
      hook = (await http("Mautic の Webhook の更新", `${conf.MAUTIC_API_URL}/api/hooks/${found.id}/edit`, { method: "PATCH", headers, json: { triggers: MAUTIC_TRIGGERS, isPublished: true } }))?.hook;
      log(`  #${found.id}: イベントを直した`);
    }
  } else {
    hook = (
      await http("Mautic の Webhook の作成", `${conf.MAUTIC_API_URL}/api/hooks/new`, {
        method: "POST",
        headers,
        json: {
          name: MAUTIC_HOOK_NAME,
          description: "n8n の I-11 へ送る（middleware/n8n/provision が作成）",
          webhookUrl: conf.MAUTIC_WEBHOOK_TARGET,
          eventsOrderbyDir: "ASC",
          triggers: MAUTIC_TRIGGERS,
          isPublished: true,
        },
      })
    )?.hook;
    log(`  #${hook?.id}: 作成した（${conf.MAUTIC_WEBHOOK_TARGET}）`);
  }
  if (!hook?.secret) fail("Mautic の Webhook のシークレットを取得できなかった（Mautic の API の応答に secret が無い）");
  return hook.secret;
}

// ---------------------------------------------------------------------------
// Chatwoot（api_access_token。Webhook の作成は管理者のトークンが要る）
// ---------------------------------------------------------------------------

async function ensureChatwootWebhook(conf) {
  step("Chatwoot の Webhook（I-12）");
  const base = `${conf.CHATWOOT_API_URL}/api/v1/accounts/${conf.CHATWOOT_ACCOUNT_ID}/webhooks`;
  const headers = { api_access_token: conf.CHATWOOT_API_ACCESS_TOKEN };
  const unwrap = (b) => b?.payload?.webhook ?? b?.payload ?? b;
  let list;
  try {
    list = await http("Chatwoot の Webhook の一覧", base, { headers });
  } catch (e) {
    if (e.status === 401 || e.status === 403) fail(`${e.message}。Webhook の操作には、Chatwoot の管理者（Administrator）のアクセストークンが要る`);
    throw e;
  }
  const hooks = list?.payload?.webhooks ?? list?.payload ?? [];
  const found = (Array.isArray(hooks) ? hooks : []).find((h) => h.url === conf.CHATWOOT_WEBHOOK_TARGET);
  let hook;
  if (found) {
    const same = CHATWOOT_SUBSCRIPTIONS.every((s) => found.subscriptions?.includes(s)) && found.subscriptions?.length === CHATWOOT_SUBSCRIPTIONS.length;
    if (same) {
      hook = found;
      log(`  #${found.id}: そのまま（${conf.CHATWOOT_WEBHOOK_TARGET}）`);
    } else {
      hook = unwrap(await http("Chatwoot の Webhook の更新", `${base}/${found.id}`, { method: "PATCH", headers, json: { webhook: { subscriptions: CHATWOOT_SUBSCRIPTIONS } } }));
      log(`  #${found.id}: イベントを直した`);
    }
  } else {
    hook = unwrap(await http("Chatwoot の Webhook の作成", base, { method: "POST", headers, json: { webhook: { name: CHATWOOT_HOOK_NAME, url: conf.CHATWOOT_WEBHOOK_TARGET, subscriptions: CHATWOOT_SUBSCRIPTIONS } } }));
    log(`  #${hook?.id}: 作成した（${conf.CHATWOOT_WEBHOOK_TARGET}）`);
  }
  if (!hook?.secret) fail("Chatwoot の Webhook のシークレットを取得できなかった（Chatwoot が 4.12 より古い可能性がある）");
  return hook.secret;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

async function check(conf) {
  step("接続の確認（何も作らない）");
  await n8n(conf).call("API キーの確認", "/workflows?limit=1");
  log("  n8n: API キーが通る");
  await mauticToken(conf);
  log("  Mautic: トークンを取得できる");
  await http("Chatwoot の Webhook の一覧", `${conf.CHATWOOT_API_URL}/api/v1/accounts/${conf.CHATWOOT_ACCOUNT_ID}/webhooks`, { headers: { api_access_token: conf.CHATWOOT_API_ACCESS_TOKEN } });
  log("  Chatwoot: Webhook の一覧を読める（管理者のトークン）");
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".json"));
  const lack = WORKFLOWS.filter((w) => !files.includes(w.file)).map((w) => w.file);
  if (lack.length) fail(`ワークフローの JSON が無い: ${lack.join(", ")}`);
  log(`  ワークフローの JSON: ${WORKFLOWS.length} 本ある`);
}

/**
 * 本体。CLI と setup の n8n モジュールの両方から呼ぶ。
 * @param {{ target: "dev"|"prod", conf: object, publish?: boolean, checkOnly?: boolean, io?: { log: Function, warn: Function }, restSession?: () => Promise<string> }} opts
 *   conf は buildConf の戻り値。io を渡すと出力がそちらに行く（秘密値は元から出さない）。
 *   restSession はオーナーの cookie（n8n-auth=…）を返す関数。資格情報の更新が公開 API で 405 になったとき（n8n 2.39.5）だけ呼ぶ。
 * @returns {Promise<{ workflows: Array<{ name: string, id: string, action: string, published: boolean }> }>}
 */
export async function provision({ target, conf, publish = false, checkOnly = false, io: out, restSession }) {
  if (out) io = out;
  if (target === "prod" && publish) warn("本番の親（I-11・I-12）を公開する。本番の公開は R1 の判断で行う（README の「本番」）");

  if (checkOnly) {
    await check(conf);
    return { workflows: [] };
  }

  const api = n8n(conf);
  await check(conf);
  await ensureDataTables(api, conf, target);
  const secrets = { mautic: await ensureMauticWebhook(conf), chatwoot: await ensureChatwootWebhook(conf) };
  const credIds = await ensureCredentials(api, conf, target, secrets, restSession);
  const workflows = await ensureWorkflows(api, credIds, publish);

  log("\n✓ 終わった");
  for (const w of workflows) log(`  ${w.published ? "公開" : "未公開"}  ${w.name}  ${conf.N8N_BASE_URL}/workflow/${w.id}`);
  if (!publish) log("\n親（I-11・I-12）はまだ公開していない。確かめてから --publish を付けて実行し直すか、n8n の画面で Publish を押す");
  return { workflows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return log(HELP);
  if (args.target !== "dev" && args.target !== "prod") fail("--target dev か --target prod を指定する（--help を参照）");
  const { conf, file } = loadConfig(args.target, args.config);
  log(`対象: ${args.target}（n8n ${conf.N8N_BASE_URL}）／設定: ${file}`);
  await provision({ target: args.target, conf, publish: args.publish, checkOnly: args.check });
  if (args.check) log("\n✓ 接続の確認が終わった。--check を外して実行すると、用意を始める");
}

// 直接実行されたときだけ CLI として動く（import されたときは何もしない）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  });
}
