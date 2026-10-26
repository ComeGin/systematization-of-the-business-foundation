// 開発スタック（オンプレ。127.0.0.1）の API を、テストデータの作成・確かめ・後片付けに使う補助。
// ブラウザを通さない（Node の fetch）。結合テスト（integration/tests/helpers）と同じ認証の取り方にそろえる:
//   Strapi   管理者（STRAPI_ADMIN_EMAIL・STRAPI_ADMIN_PASSWORD）の JWT で Content Manager を叩く（作成・公開・削除）
//   Mautic   OAuth2 client_credentials（dev.conf の MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET）
//   Chatwoot 管理者のトークン（CHATWOOT_ADMIN_TOKEN）
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEV, devValue } from "./env";

const TIMEOUT_MS = 20_000;

interface HttpResult<T> {
  status: number;
  json: T;
  text: string;
}

async function http<T>(
  url: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResult<T>> {
  const { method = "GET", body, headers = {} } = init;
  const isForm = body instanceof URLSearchParams;
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined || isForm
        ? {}
        : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: T;
  try {
    json = (text ? JSON.parse(text) : null) as T;
  } catch {
    json = null as T;
  }
  return { status: res.status, json, text };
}

/** 決まった時間まで、条件を満たす値が返るのを待つ（非同期に作られるもの: Mautic のコンタクト・ボットの返事など） */
export async function eventually<T>(
  what: string,
  read: () => Promise<T | undefined>,
  { timeoutMs = 20_000, intervalMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`${what} を ${timeoutMs}ms 待ったが届かなかった`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---- Strapi ----

export const ARTICLE = "api::article.article";

let strapiJwt: string | undefined;

async function strapiAdminJwt(): Promise<string> {
  if (strapiJwt) return strapiJwt;
  const res = await http<{ data?: { token?: string } }>(
    `${DEV.strapi}/admin/login`,
    {
      method: "POST",
      body: {
        email: devValue("STRAPI_ADMIN_EMAIL"),
        password: devValue("STRAPI_ADMIN_PASSWORD"),
      },
    },
  );
  if (res.status === 429)
    throw new Error(
      "Strapi の管理者のログインがレート制限（5 分に 5 回）に当たった。5 分待ってから実行し直す",
    );
  if (res.status !== 200 || !res.json?.data?.token)
    throw new Error(`Strapi の管理者でログインできない（HTTP ${res.status}）`);
  strapiJwt = res.json.data.token;
  return strapiJwt;
}

async function contentManager<T>(
  uid: string,
  suffix: string,
  init: { method?: string; body?: unknown } = {},
) {
  return http<T>(
    `${DEV.strapi}/content-manager/collection-types/${uid}${suffix}`,
    {
      ...init,
      headers: { authorization: `Bearer ${await strapiAdminJwt()}` },
    },
  );
}

/** 公開サイトのビルドと同じ読み取り専用トークンで Content API を読む */
export async function strapiContent<T>(
  pathAndQuery: string,
): Promise<HttpResult<T>> {
  return http<T>(`${DEV.strapi}/api/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${devValue("STRAPI_BUILD_TOKEN")}` },
  });
}

/** カテゴリの documentId（公開サイトのタブと同じ slug。開発の Strapi に作ってある） */
export async function categoryDocumentId(slug: string): Promise<string> {
  const res = await strapiContent<{ data?: { documentId: string }[] }>(
    `categories?filters[slug][$eq]=${encodeURIComponent(slug)}`,
  );
  const id = res.json?.data?.[0]?.documentId;
  if (res.status !== 200 || !id) {
    throw new Error(
      `開発の Strapi にカテゴリ ${slug} が無い（HTTP ${res.status}）。公開サイトのタブと同じ slug のカテゴリを作ってから実行する`,
    );
  }
  return id;
}

/** 管理者で記事を作る（下書き）。documentId を返す */
export async function createArticle(
  data: Record<string, unknown>,
): Promise<string> {
  const res = await contentManager<{ data?: { documentId?: string } }>(
    ARTICLE,
    "",
    { method: "POST", body: data },
  );
  if (res.status !== 201 || !res.json?.data?.documentId) {
    throw new Error(
      `Strapi に記事を作れない（HTTP ${res.status}: ${res.text.slice(0, 200)}）`,
    );
  }
  return res.json.data.documentId;
}

export async function publishArticle(documentId: string): Promise<void> {
  const res = await contentManager(ARTICLE, `/${documentId}/actions/publish`, {
    method: "POST",
    body: {},
  });
  if (res.status !== 200)
    throw new Error(
      `Strapi の記事 ${documentId} を公開できない（HTTP ${res.status}）`,
    );
}

/** 後片付け。既に無ければ何もしない */
export async function deleteArticle(documentId: string): Promise<void> {
  const res = await contentManager(ARTICLE, `/${documentId}`, {
    method: "DELETE",
  });
  if (res.status !== 200 && res.status !== 404)
    throw new Error(
      `Strapi の記事 ${documentId} を消せない（HTTP ${res.status}）`,
    );
}

// ---- Mautic ----

let mauticToken: { value: string; expiresAt: number } | undefined;

async function mauticBearer(): Promise<string> {
  if (mauticToken && mauticToken.expiresAt - 60_000 > Date.now())
    return mauticToken.value;
  const res = await http<{ access_token?: string; expires_in?: number }>(
    `${DEV.mautic}/oauth/v2/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: devValue("MAUTIC_CLIENT_ID"),
        client_secret: devValue("MAUTIC_CLIENT_SECRET"),
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
  );
  if (res.status !== 200 || !res.json?.access_token)
    throw new Error(`Mautic のトークンを取れない（HTTP ${res.status}）`);
  mauticToken = {
    value: res.json.access_token,
    expiresAt: Date.now() + (res.json.expires_in ?? 3600) * 1000,
  };
  return mauticToken.value;
}

async function mauticApi<T>(suffix: string, init: { method?: string } = {}) {
  return http<T>(`${DEV.mautic}/api${suffix}`, {
    ...init,
    headers: { authorization: `Bearer ${await mauticBearer()}` },
  });
}

export interface MauticContact {
  id: number;
  fields: { all: Record<string, unknown> };
}

/** メールの完全一致のコンタクト（無ければ空） */
export async function mauticContactsByEmail(
  email: string,
): Promise<MauticContact[]> {
  const res = await mauticApi<{ contacts?: Record<string, MauticContact> }>(
    `/contacts?search=${encodeURIComponent(`email:${email}`)}&limit=10`,
  );
  if (res.status !== 200)
    throw new Error(
      `Mautic のコンタクトの検索に失敗した（HTTP ${res.status}）`,
    );
  return Object.values(res.json?.contacts ?? {}).filter(
    (c) =>
      String(c.fields.all.email ?? "").toLowerCase() === email.toLowerCase(),
  );
}

export interface MauticSubmission {
  id: number;
  results: Record<string, unknown>;
}

/** フォームの送信結果のうち、そのコンタクトのもの（hidden の page_url・cta_id などはコンタクトではなくここにだけ残る） */
export async function mauticSubmissionsOf(
  formId: number,
  contactId: number,
): Promise<MauticSubmission[]> {
  const res = await mauticApi<{
    submissions?: MauticSubmission[] | Record<string, MauticSubmission>;
  }>(`/forms/${formId}/submissions/contact/${contactId}`);
  if (res.status !== 200)
    throw new Error(
      `Mautic のフォームの送信結果を読めない（HTTP ${res.status}）`,
    );
  return Object.values(res.json?.submissions ?? {});
}

/** コンタクトを消す（送信結果は Mautic の API では消せないので残る。メールの接頭辞 e2e- で見分ける） */
export async function deleteMauticContact(id: number): Promise<void> {
  const res = await mauticApi(`/contacts/${id}/delete`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404)
    throw new Error(
      `Mautic のコンタクト ${id} を消せない（HTTP ${res.status}）`,
    );
}

/**
 * 申し込みの後片付け。そのメールのコンタクトをすべて消し、届いた受付確認のメール（MailHog）も消す（作られていなければ何もしない）。
 * 自動返信は Mautic の送信の後に届くので、メールは少し待ってから消す
 */
export async function deleteMauticContactsByEmail(
  email: string,
): Promise<void> {
  for (const contact of await mauticContactsByEmail(email))
    await deleteMauticContact(contact.id);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await deleteMailhogMessagesTo(email);
}

// ---- MailHog（Mautic が送るメールの届き先。開発だけ） ----

interface MailhogItem {
  ID: string;
  Content: { Headers: Record<string, string[]> };
}

/** =?UTF-8?B?…?= ／ =?UTF-8?Q?…?= の見出しを読める文字にする */
function decodeMimeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(
      /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
      (_, _charset: string, kind: string, text: string) =>
        kind.toUpperCase() === "B"
          ? Buffer.from(text, "base64").toString("utf8")
          : Buffer.from(
              text
                .replace(/_/g, " ")
                .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
              "latin1",
            ).toString("utf8"),
    );
}

/** その宛先に届いたメールの件名 */
export async function mailhogSubjectsTo(
  email: string,
): Promise<{ id: string; subject: string }[]> {
  const res = await http<{ items?: MailhogItem[] }>(
    `${DEV.mailhog}/api/v2/search?kind=to&query=${encodeURIComponent(email)}`,
  );
  if (res.status !== 200)
    throw new Error(`MailHog を読めない（HTTP ${res.status}）`);
  return (res.json?.items ?? []).map((item) => ({
    id: item.ID,
    subject: decodeMimeWords(item.Content.Headers.Subject?.[0] ?? ""),
  }));
}

/** その宛先に届いたメールを消す（後片付け） */
export async function deleteMailhogMessagesTo(email: string): Promise<void> {
  for (const { id } of await mailhogSubjectsTo(email)) {
    await fetch(`${DEV.mailhog}/api/v1/messages/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}

// ---- Chatwoot ----

async function chatwootApi<T>(
  suffix: string,
  init: { method?: string; body?: unknown } = {},
) {
  return http<T>(
    `${DEV.chatwoot}/api/v1/accounts/${devValue("CHATWOOT_ACCOUNT_ID")}${suffix}`,
    {
      ...init,
      headers: { api_access_token: devValue("CHATWOOT_ADMIN_TOKEN") },
    },
  );
}

export interface ChatwootConversation {
  id: number;
  status: string;
  labels: string[];
  meta: { sender?: { id: number } };
}

export async function chatwootConversation(
  displayId: number,
): Promise<ChatwootConversation> {
  const res = await chatwootApi<ChatwootConversation>(
    `/conversations/${displayId}`,
  );
  if (res.status !== 200 || !res.json)
    throw new Error(
      `Chatwoot の会話 ${displayId} を読めない（HTTP ${res.status}）`,
    );
  return res.json;
}

export interface ChatwootMessage {
  id: number;
  content: string | null;
  message_type: number; // 0 incoming・1 outgoing・2 activity・3 template
  content_type: string;
  content_attributes?: { items?: { title: string; value: string }[] };
}

export async function chatwootMessages(
  displayId: number,
): Promise<ChatwootMessage[]> {
  const res = await chatwootApi<{ payload?: ChatwootMessage[] }>(
    `/conversations/${displayId}/messages`,
  );
  if (res.status !== 200)
    throw new Error(
      `Chatwoot の会話 ${displayId} のメッセージを読めない（HTTP ${res.status}）`,
    );
  return res.json?.payload ?? [];
}

/** 会話とコンタクトを消す（会話の削除は管理者だけ。コンタクトを消しても会話は残るため、両方を消す） */
export async function deleteChatwootConversation(
  displayId: number,
): Promise<void> {
  const conversation = await chatwootConversation(displayId).catch(() => null);
  const removed = await chatwootApi(`/conversations/${displayId}`, {
    method: "DELETE",
  });
  if (![200, 204, 404].includes(removed.status))
    throw new Error(
      `Chatwoot の会話 ${displayId} を消せない（HTTP ${removed.status}）`,
    );
  const contactId = conversation?.meta.sender?.id;
  if (!contactId) return;
  // ウィジェットの訪問者は、最後の接続から CONTACT_PRESENCE_DURATION（既定 90 秒）の間オンラインとみなされ、
  // その間はコンタクトを消せない（422。Chatwoot の contacts_controller#destroy と lib/online_status_tracker.rb）。
  // テストごとに 90 秒待たないよう、消せなければ後で消す一覧に残し、全テストの後（global-setup の teardown）で消す
  if (!(await tryDeleteChatwootContact(contactId)))
    deferChatwootContact(contactId);
}

/** コンタクトを消す。オンラインで消せないときは false */
async function tryDeleteChatwootContact(contactId: number): Promise<boolean> {
  const contact = await chatwootApi(`/contacts/${contactId}`, {
    method: "DELETE",
  });
  if ([200, 204, 404].includes(contact.status)) return true;
  if (contact.status === 422) return false;
  throw new Error(
    `Chatwoot のコンタクト ${contactId} を消せない（HTTP ${contact.status}）`,
  );
}

// 後で消すコンタクトの一覧（ワーカーと親のプロセスで受け渡すのでファイルに置く。test-results/ は Git の管理外）
const PENDING_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test-results/e2e-pending",
);

function deferChatwootContact(contactId: number): void {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(path.join(PENDING_DIR, `chatwoot-contact-${contactId}`), "");
}

/** 後で消す一覧のコンタクトを消す（オンラインの間は待つ。global-setup の teardown が呼ぶ） */
export async function deletePendingChatwootContacts(): Promise<void> {
  const ids = existsSync(PENDING_DIR)
    ? readdirSync(PENDING_DIR)
        .map((name) => /^chatwoot-contact-(\d+)$/.exec(name)?.[1])
        .filter((id): id is string => id !== undefined)
        .map(Number)
    : [];
  for (const id of ids) {
    await eventually(
      `Chatwoot のコンタクト ${id} の削除（オンラインの間は消せない）`,
      async () => ((await tryDeleteChatwootContact(id)) ? true : undefined),
      { timeoutMs: 150_000, intervalMs: 5_000 },
    );
    rmSync(path.join(PENDING_DIR, `chatwoot-contact-${id}`), { force: true });
  }
}

/**
 * ウィジェットの訪問者の会話（ブラウザの cw_conversation の JWT で、ウィジェットの API から読む）。
 * ウィジェットが作ったコンタクトは名前もメールも持たないので、後片付けはこの経路で番号を知る。
 */
export async function widgetConversationId(
  websiteToken: string,
  cwConversation: string,
): Promise<number | undefined> {
  const res = await http<{ id?: number } | null>(
    `${DEV.chatwoot}/api/v1/widget/conversations?website_token=${encodeURIComponent(websiteToken)}`,
    { headers: { "x-auth-token": cwConversation } },
  );
  return res.status === 200 && res.json?.id ? res.json.id : undefined;
}

// ---- consent-api ----

/** 同意の Cookie の識別子が指す最新の記録（Origin を付けない GET。ブラウザの外から読むので CORS は掛からない） */
export async function consentRecord(
  cookieValue: string,
): Promise<{ state: string; policy_version?: string }> {
  const res = await http<{ state: string; policy_version?: string }>(
    `${DEV.consentApi}/v1/consent`,
    {
      headers: { cookie: `comegin_consent=${cookieValue}` },
    },
  );
  if (res.status !== 200 || !res.json)
    throw new Error(`consent-api の記録を読めない（HTTP ${res.status}）`);
  return res.json;
}

/** 同意の記録（Valkey の Stream）を消す。consent-api には削除の API が無いので、コンテナの中の valkey-cli で消す */
export async function deleteConsentRecord(id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id))
    throw new Error("同意の識別子の形が想定と違う");
  await docker(
    "exec",
    "consent-api-valkey-1",
    "valkey-cli",
    "DEL",
    `consent:c:${id}`,
  );
}

/**
 * 決まった時刻より後に作られた同意の記録（最初の記録の時刻で見る）のキー。
 * Valkey を docker pause で止めている間の同意は、consent-api が 503 を返して Cookie を書かない。送りかけの書き込みは
 * Valkey が戻った時点で実行されるが、期限を過ぎているので書かれない（backend/consent-api の README。2026-10-26 に直した）。
 * 障害のテストが、止めている間に記録が増えていないことを確かめるのに使う
 */
export async function consentRecordKeysCreatedSince(
  since: number,
): Promise<string[]> {
  const keys = (
    await docker(
      "exec",
      "consent-api-valkey-1",
      "valkey-cli",
      "--scan",
      "--pattern",
      "consent:c:*",
    )
  )
    .split("\n")
    .filter(Boolean);
  const created: string[] = [];
  for (const key of keys) {
    const first = await docker(
      "exec",
      "consent-api-valkey-1",
      "valkey-cli",
      "XRANGE",
      key,
      "-",
      "+",
      "COUNT",
      "1",
    );
    const createdAt = Number(first.split("\n")[0]?.split("-")[0]);
    if (createdAt >= since) created.push(key);
  }
  return created;
}

// ---- 障害を起こす（docker pause） ----

const run = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: 30_000 });
  return stdout.trim();
}

/**
 * コンテナを一時停止して fn を実行し、成否にかかわらず再開する（SIGSTOP 相当。接続は張られたまま応答だけが止まる）。
 * 始める前から running でなければ失敗にする（壊れた状態の上で試さない）。
 */
export async function withPaused<T>(
  container: string,
  fn: () => Promise<T>,
): Promise<T> {
  const before = await docker(
    "inspect",
    "-f",
    "{{.State.Status}}",
    container,
  ).catch(() => undefined);
  if (before !== "running")
    throw new Error(
      `${container} が running ではない（${before ?? "存在しない"}）`,
    );
  await docker("pause", container);
  try {
    return await fn();
  } finally {
    await docker("unpause", container);
  }
}

/** 生きているかを見る（認証の要らないパス）。落ちているものの名前を返す */
export async function unreachableServices(): Promise<string[]> {
  const checks: [string, string][] = [
    ["Strapi", `${DEV.strapi}/_health`],
    ["Mautic", `${DEV.mautic}/s/login`],
    ["Chatwoot", `${DEV.chatwoot}/api`],
    ["consent-api", `${DEV.consentApi}/healthz`],
    ["faq-bot", `${DEV.faqBot}/healthz`],
  ];
  const results = await Promise.all(
    checks.map(async ([name, url]) => {
      try {
        const res = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        return res.status < 500 ? null : `${name}（HTTP ${res.status}）`;
      } catch {
        return `${name}（${new URL(url).host} に届かない）`;
      }
    }),
  );
  return results.filter((r): r is string => r !== null);
}
