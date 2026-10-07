// n8n の結合テスト（I-11・I-12・I-19・I-21）だけが使う補助。共有の tests/helpers は変えず、ここに置く。
//
// - 署名: Mautic は「生の本文」の HMAC-SHA256 を base64（WebhookBundle/Http/Client.php）、
//   Chatwoot は「{時刻}.{生の本文}」の HMAC-SHA256 を 16 進にして sha256= を前に付ける（middleware/n8n/workflows/README.md）
// - 鍵: provision が作った Mautic の Webhook（"n8n I-11"）と Chatwoot の Webhook（"n8n I-12"）のシークレットを、各製品の API から読む。
//   値は返すだけで、画面・例外の文に出さない
// - Data Table の行の削除と実行履歴の参照は、setup が作る公開 API のキー（N8N_API_KEY）のスコープに無い（dataTableRow:delete・execution:read）。
//   setup の n8n モジュールと同じく、オーナーでログインした cookie で内部の API（/rest）と公開 API の GET を使う
import { createHmac, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";

import { requireValue } from "../helpers/env.ts";
import { http, type HttpResult } from "../helpers/http.ts";
import { deleteMail, searchMail, subjectOf, type MailhogMessage } from "../helpers/mailhog.ts";
import { mauticApi } from "../helpers/mautic.ts";
import { chatwootApi, chatwootWidgetSession } from "../helpers/chatwoot.ts";
import { execIn } from "../helpers/docker.ts";
import { n8nApi, findWorkflow } from "../helpers/n8n.ts";
import { DEV } from "../helpers/services.ts";
import { waitFor } from "../helpers/wait.ts";

// ---------------------------------------------------------------------------
// 署名と送信
// ---------------------------------------------------------------------------

export const signMautic = (rawBody: string, secret: string): string => createHmac("sha256", secret).update(rawBody).digest("base64");

export const signChatwoot = (timestamp: string, rawBody: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * 合成した Webhook に入れる ID（Mautic の contact_id・Chatwoot の display_id とコンタクト ID）。実在の ID（数百まで）と重ならない
 * 7 億台から、実行ごとにずらして払い出す。冪等キー（dedup_*）と contact_link は数値の ID しか持たないので、RUN_ID の代わりにこれで絞る
 */
export function idSequence(): () => number {
  let n = 700_000_000 + randomInt(0, 99_000) * 1_000;
  return () => ++n;
}

/**
 * probe の一覧が count 件以上になるまで待つ（Webhook の後続は 200 を返した後に非同期で動く。Code ノードは外部のタスクランナーが
 * 必要になってから起動するので、最初の 1 回は数秒かかる）
 */
export async function waitForList<T>(probe: () => Promise<T[]>, what: string, count = 1): Promise<T[]> {
  return waitFor(async () => {
    const list = await probe();
    return list.length >= count && list;
  }, { what, timeoutMs: 40_000 });
}

/** provision が作った Mautic の Webhook（I-11 の送り先）のシークレット */
export async function mauticWebhookSecret(): Promise<string> {
  const res = await mauticApi<{ hooks?: Record<string, { name: string; webhookUrl: string; secret?: string }> }>("/hooks?limit=200");
  const hook = Object.values(res.json?.hooks ?? {}).find((h) => h.name === "n8n I-11" && h.webhookUrl.endsWith("/webhook/mautic-event"));
  if (!hook?.secret) throw new Error(`Mautic の Webhook「n8n I-11」のシークレットを読めない（HTTP ${res.status}。setup の n8n モジュールを先に済ませる）`);
  return hook.secret;
}

/**
 * Mautic の Webhook「n8n I-11」を公開の状態にし、元に戻す関数を返す。Mautic は送信に失敗した Webhook を自動で止める
 * （WebhookModel::processWebhook の isSick → killWebhook。disable_auto_unpublish が false のとき）。開発では I-11 が未公開（404）の
 * 間に他の操作でコンタクトが変わると止まるので、通しのテストの間だけ公開に戻す
 */
export async function publishMauticHook(): Promise<() => Promise<void>> {
  const res = await mauticApi<{ hooks?: Record<string, { id: number; name: string; isPublished: boolean }> }>("/hooks?limit=200");
  const hook = Object.values(res.json?.hooks ?? {}).find((h) => h.name === "n8n I-11");
  if (!hook) throw new Error(`Mautic の Webhook「n8n I-11」が無い（HTTP ${res.status}）`);
  if (hook.isPublished) return async () => {};
  const set = async (isPublished: boolean): Promise<void> => {
    const r = await mauticApi(`/hooks/${hook.id}/edit`, { method: "PATCH", body: { isPublished } });
    if (r.status !== 200) throw new Error(`Mautic の Webhook ${hook.id} の公開を ${isPublished} にできない（HTTP ${r.status}）`);
  };
  await set(true);
  return () => set(false);
}

/** provision が作った Chatwoot の Webhook（I-12 の送り先）のシークレット。管理者のトークンでしか読めない */
export async function chatwootWebhookSecret(): Promise<string> {
  const res = await chatwootApi<{ payload?: { webhooks?: Array<{ name: string; url: string; secret?: string }> } }>("/webhooks");
  const hook = (res.json?.payload?.webhooks ?? []).find((h) => h.name === "n8n I-12" && h.url.endsWith("/webhook/chatwoot-event"));
  if (!hook?.secret) throw new Error(`Chatwoot の Webhook「n8n I-12」のシークレットを読めない（HTTP ${res.status}）`);
  return hook.secret;
}

/** n8n の本番の Webhook の URL（/webhook/…。公開したワークフローだけが受ける）に生の本文を送る */
export async function postWebhook(path: "mautic-event" | "chatwoot-event", rawBody: string, headers: Record<string, string> = {}): Promise<HttpResult<{ status?: string; error?: string }>> {
  return http(`${DEV.n8n}/webhook/${path}`, { method: "POST", body: rawBody, headers: { "content-type": "application/json", ...headers } });
}

// ---------------------------------------------------------------------------
// 公開経路（I-07 のウィジェット・I-08 の Mautic のフォーム）
// ---------------------------------------------------------------------------

/**
 * I-07: 公開サイトのチャットウィジェットと同じ入口（共有の chatwootWidgetSession）で、email を付けて最初のメッセージと一緒に会話を作る
 * （app/controllers/api/v1/widget/conversations_controller.rb の create。応答の id が display_id）
 */
export async function startWidgetConversation(input: { email: string; name: string; content: string }): Promise<{ status: number; displayId: number; contactId: number }> {
  const session = await chatwootWidgetSession();
  const conversation = await session.call<{ id: number; contact?: { id: number } }>("/conversations", {
    method: "POST",
    body: { contact: { email: input.email, name: input.name }, message: { content: input.content, timestamp: new Date().toString(), referer_url: "http://localhost:4321/contact" } },
  });
  return { status: conversation.status, displayId: Number(conversation.json?.id ?? 0), contactId: Number(conversation.json?.contact?.id ?? 0) };
}

/**
 * I-08: 公開サイトのフォームと同じく、Mautic の /form/submit に mauticform[…] で送る（?ajax=1 で JSON の応答。FormBundle の PublicController）。
 * fields は Mautic のフォームの項目の alias
 */
export async function submitMauticForm(formId: string, formName: string, fields: Record<string, string>): Promise<HttpResult<{ success?: number; validationErrors?: Record<string, string>; errorMessage?: string }>> {
  const body = new URLSearchParams({ "mauticform[formId]": formId, "mauticform[formName]": formName, "mauticform[return]": "", "mauticform[messenger]": "1" });
  for (const [k, v] of Object.entries(fields)) body.set(`mauticform[${k}]`, v);
  return http(`${DEV.mautic}/form/submit?formId=${encodeURIComponent(formId)}&ajax=1`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
}

/**
 * I-08 の後片付け: フォームの送信記録（form_submissions）と結果の表（form_results_<id>_<alias>）の行を、email で絞って消す。
 * Mautic の API に送信記録の削除が無いため、開発の MySQL（mautic-mysql）で消す。消すのは it- で始まる email の行だけ
 * （他の担当・人が送った行に触れないよう、email は完全一致。値と表の名前は形を確かめてから SQL に入れる）。消した件数を返す
 */
export async function deleteFormSubmissions(formId: string, formAlias: string, email: string): Promise<number> {
  if (!/^\d+$/.test(formId) || !/^[a-z0-9_]+$/.test(formAlias)) throw new Error(`フォームの ID か alias の形が違う（${formId}・${formAlias}）`);
  if (!/^it-[a-z0-9.-]+@example\.com$/.test(email)) throw new Error("消してよいのは it- で始まる example.com のメールの送信記録だけ");
  const sql =
    `DELETE s, r FROM form_submissions s JOIN form_results_${formId}_${formAlias} r ON r.submission_id = s.id ` +
    `WHERE s.form_id = ${formId} AND r.form_id = ${formId} AND r.email = '${email}'; SELECT ROW_COUNT();`;
  // 接続情報はコンテナの環境変数をコンテナの中で使う（値はこちらに出さない）。SQL は sh の位置引数で渡す
  const out = await execIn("mautic-mysql", ["sh", "-c", 'mysql -N -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "$1" 2>/dev/null', "sh", sql]);
  return Number(out.trim().split("\n").pop() ?? 0);
}

// ---------------------------------------------------------------------------
// オーナーのセッション（内部の API）
// ---------------------------------------------------------------------------

let ownerCookie: string | undefined;

async function owner(): Promise<string> {
  if (ownerCookie) return ownerCookie;
  const res = await fetch(`${DEV.n8n}/rest/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emailOrLdapLoginId: requireValue("N8N_OWNER_EMAIL"), password: requireValue("N8N_OWNER_PASSWORD") }),
    signal: AbortSignal.timeout(20_000),
  });
  await res.text();
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith("n8n-auth="));
  if (!res.ok || !cookie) throw new Error(`n8n のオーナーでログインできない（HTTP ${res.status}）`);
  ownerCookie = cookie;
  return cookie;
}

async function ownerHttp<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResult<T>> {
  return http<T>(`${DEV.n8n}${path}`, { ...init, headers: { cookie: await owner(), accept: "application/json" } });
}

// ---------------------------------------------------------------------------
// Data Table
// ---------------------------------------------------------------------------

export type TableName = "dedup_mautic" | "dedup_chatwoot" | "contact_link" | "ops_settings" | "monitor_state";
export type Row = Record<string, unknown> & { id: number };
type Condition = { columnName: string; condition: "eq" | "gt" | "lt" | "neq"; value: string | number };

const tableCache = new Map<string, { id: string; projectId: string }>();

async function table(name: TableName): Promise<{ id: string; projectId: string }> {
  const cached = tableCache.get(name);
  if (cached) return cached;
  const res = await n8nApi<{ data: Array<{ id: string; name: string; projectId: string }> }>("/data-tables?limit=100");
  const found = res.json?.data.find((t) => t.name === name);
  if (!found) throw new Error(`n8n の Data Table「${name}」が無い（HTTP ${res.status}）`);
  tableCache.set(name, { id: found.id, projectId: found.projectId });
  return found;
}

const filterOf = (conditions: Condition[]): string => JSON.stringify({ type: "and", filters: conditions });

/** 条件に合う行（公開 API。最大 250 行） */
export async function rows(name: TableName, conditions: Condition[]): Promise<Row[]> {
  const { id } = await table(name);
  const res = await n8nApi<{ data: Row[] }>(`/data-tables/${id}/rows?limit=250&filter=${encodeURIComponent(filterOf(conditions))}`);
  if (res.status !== 200) throw new Error(`Data Table「${name}」の行を読めない（HTTP ${res.status}）`);
  return res.json?.data ?? [];
}

/** 条件に合う行を消す（内部の API。条件が空だと n8n が拒む） */
export async function deleteRows(name: TableName, conditions: Condition[]): Promise<void> {
  const { id, projectId } = await table(name);
  const res = await ownerHttp(`/rest/projects/${projectId}/data-tables/${id}/rows?filter=${encodeURIComponent(filterOf(conditions))}`, { method: "DELETE" });
  if (res.status !== 200) throw new Error(`Data Table「${name}」の行を消せない（HTTP ${res.status}）`);
}

/** いま一番大きい行の id（無ければ 0）。テストの間に増えた行を後片付けで見分けるのに使う */
export async function maxRowId(name: TableName): Promise<number> {
  const { id } = await table(name);
  const res = await n8nApi<{ data: Row[] }>(`/data-tables/${id}/rows?limit=1&sortBy=${encodeURIComponent("id:desc")}`);
  if (res.status !== 200) throw new Error(`Data Table「${name}」の行を読めない（HTTP ${res.status}）`);
  return Number(res.json?.data[0]?.id ?? 0);
}

/** ops_settings の値を変え、元の値に戻す関数を返す */
export async function overrideSetting(key: string, value: string): Promise<() => Promise<void>> {
  const [before] = await rows("ops_settings", [{ columnName: "key", condition: "eq", value: key }]);
  if (!before) throw new Error(`ops_settings に ${key} が無い`);
  const { id } = await table("ops_settings");
  const set = async (v: unknown): Promise<void> => {
    const res = await n8nApi(`/data-tables/${id}/rows/upsert`, {
      method: "POST",
      body: { filter: { type: "and", filters: [{ columnName: "key", condition: "eq", value: key }] }, data: { key, value: v } },
    });
    if (res.status !== 200) throw new Error(`ops_settings の ${key} を書けない（HTTP ${res.status}）`);
  };
  await set(value);
  return () => set(before.value);
}

// ---------------------------------------------------------------------------
// I-19 の Mautic の代わりに立てる偽の HTTP サーバ（サーバ側の失敗を起こすため）
// ---------------------------------------------------------------------------

/**
 * n8n のコンテナから host.docker.internal（docker0 の 172.17.0.1）で届く偽の Mautic。どの要求にも status を返す。
 * docker0 のアドレスにだけ開き、LAN には開かない。I-19 は ops_settings の mauticBaseUrl を毎回読むので、そこをこの URL に差し替える
 */
export async function startFakeMautic(status: number): Promise<{ urlFromN8n: string; hits: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    count++;
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ code: status, message: "fake mautic" }] }));
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "172.17.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    urlFromN8n: `http://host.docker.internal:${port}`,
    hits: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 何も待ち受けていない（接続を拒まれる）host.docker.internal のポート */
export async function closedPortUrl(): Promise<string> {
  const fake = await startFakeMautic(500);
  await fake.close();
  return fake.urlFromN8n;
}

// ---------------------------------------------------------------------------
// 実行履歴
// ---------------------------------------------------------------------------

export interface Execution {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
  data?: { resultData?: { error?: { message?: string }; runData?: Record<string, Array<{ error?: { message?: string; httpCode?: string }; data?: { main?: Array<Array<{ json: Record<string, unknown> }> | null> } }>> } };
}

/** ワークフローの実行履歴（新しい順。公開 API をオーナーの cookie で読む） */
export async function executions(workflowId: string, options: { status?: "error" | "success"; includeData?: boolean } = {}): Promise<Execution[]> {
  const q = new URLSearchParams({ workflowId, limit: "50" });
  if (options.status) q.set("status", options.status);
  if (options.includeData) q.set("includeData", "true");
  const res = await ownerHttp<{ data: Execution[] }>(`/api/v1/executions?${q}`);
  if (res.status !== 200) throw new Error(`n8n の実行履歴を読めない（HTTP ${res.status}）`);
  return res.json?.data ?? [];
}

async function deleteExecutions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await ownerHttp("/rest/executions/delete", { method: "POST", body: { ids } });
  if (res.status !== 200) throw new Error(`n8n の実行履歴を消せない（HTTP ${res.status}）`);
}

// ---------------------------------------------------------------------------
// I-21 の通知（開発は MailHog。差出人 n8n@comegin.local）
// ---------------------------------------------------------------------------

export const ALERT_FROM = "n8n@comegin.local";

/** 件名に fragment を含む I-21 の通知（件名は ASCII だけなので、件名で探す。本文は quoted-printable で折り返される） */
export async function alerts(fragment: string): Promise<MailhogMessage[]> {
  return (await searchMail("containing", fragment)).filter((m) => m.Raw.From === ALERT_FROM && subjectOf(m).includes(fragment));
}

/** quoted-printable の本文を UTF-8 の文字列に戻す */
export function decodeBody(m: MailhogMessage): string {
  const body = m.Content.Body;
  const encoding = (m.Content.Headers["Content-Transfer-Encoding"]?.[0] ?? "").toLowerCase();
  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding !== "quoted-printable") return body;
  const soft = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === "=" && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i] ?? "", "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

// ---------------------------------------------------------------------------
// 親（I-11・I-12）を有効にしている間に増えたものの後片付け
// ---------------------------------------------------------------------------

const WINDOW_TABLES: TableName[] = ["dedup_mautic", "dedup_chatwoot", "contact_link"];
const WINDOW_WORKFLOWS = ["I-11 ", "I-12 ", "I-19 ", "I-21 "];

/**
 * 親を有効にしている間は、他の担当（B）が Chatwoot・Mautic に作るデータでも I-11・I-12 が動き、Data Table の行・通知のメール・
 * 失敗した実行の記録が増える。どれも親を有効にしたことの結果なので、始めた時点の位置を覚えておき、後片付けでその後の分だけを消す
 * （親が無効の間は Webhook が 404 になり、これらの表とメールに書くものは他に無い）。
 */
export class N8nWindow {
  #baseline = new Map<TableName, number>();
  #startedAt = 0;
  #lastExecutionId = new Map<string, number>();

  async open(): Promise<void> {
    this.#startedAt = Date.now() - 1_000;
    for (const t of WINDOW_TABLES) this.#baseline.set(t, await maxRowId(t));
    for (const prefix of WINDOW_WORKFLOWS) {
      const wf = await findWorkflow(prefix);
      this.#lastExecutionId.set(wf.id, Math.max(0, ...(await executions(wf.id)).map((e) => Number(e.id))));
    }
  }

  async close(): Promise<void> {
    for (const [t, id] of this.#baseline) await deleteRows(t, [{ columnName: "id", condition: "gt", value: id }]);
    const mails = (await searchMail("from", ALERT_FROM)).filter((m) => Date.parse((m as MailhogMessage & { Created?: string }).Created ?? "") >= this.#startedAt);
    for (const m of mails) await deleteMail(m.ID);
    for (const [workflowId, last] of this.#lastExecutionId) {
      await deleteExecutions((await executions(workflowId)).map((e) => e.id).filter((id) => Number(id) > last));
    }
  }
}
