// 開発の Strapi（127.0.0.1:1337）と Mautic（127.0.0.1:8000）を、改善ループの結合テストから操作する補助。
// 本番では、エージェントが MCP（strapi-prod・mautic-prod）で下書きと未公開のメール・キャンペーンを作り、人（R2）が管理画面で公開する。
// 結合テストでは、エージェント（Agent SDK はモック）の代わりにここから同じものを作り、人の代わりにここから公開する。
//
//   Strapi 管理者          STRAPI_ADMIN_EMAIL・STRAPI_ADMIN_PASSWORD（dev.conf）。下書きの作成・更新・公開・削除と、API トークンの発行と削除
//   STRAPI_BUILD_TOKEN     Content API の読み取り専用トークン（本番の CONTROL_STRAPI_READ_TOKEN にあたる）
//   書き込みトークン       テストの間だけ発行する Content API のトークン（Upload の upload と Article の update だけ。本番の CONTROL_STRAPI_WRITE_TOKEN と同じ権限）
//   Mautic                 MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET（dev.conf。OAuth2 client_credentials）
// 秘密値は例外の文に出さない（キーの名前と HTTP ステータスだけ）。
import { requireValue } from "../../../../integration/tests/helpers/env.ts";
import { http, type HttpResult } from "../../../../integration/tests/helpers/http.ts";
import { mauticApi } from "../../../../integration/tests/helpers/mautic.ts";
import { DEV } from "../../../../integration/tests/helpers/services.ts";

const ARTICLE = "api::article.article";
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

export const strapiReadToken = (): string => requireValue("STRAPI_BUILD_TOKEN");
export const mauticClient = (): { id: string; secret: string } => ({ id: requireValue("MAUTIC_CLIENT_ID"), secret: requireValue("MAUTIC_CLIENT_SECRET") });

// ---- Strapi ----

let jwt: string | undefined;

/** 管理者の JWT（ファイルの中でだけ使い回す。管理者のログインは 5 分に 5 回までなので、1 回だけにする） */
async function adminJwt(): Promise<string> {
  if (jwt) return jwt;
  const res = await http<{ data?: { token?: string } }>(`${DEV.strapi}/admin/login`, {
    method: "POST",
    body: { email: requireValue("STRAPI_ADMIN_EMAIL"), password: requireValue("STRAPI_ADMIN_PASSWORD") },
  });
  if (res.status === 429) throw new Error("Strapi の管理者のログインがレート制限（5 分に 5 回）に当たった。5 分待ってから実行し直す");
  if (res.status !== 200 || !res.json?.data?.token) throw new Error(`Strapi の管理者でログインできない（HTTP ${res.status}）`);
  jwt = res.json.data.token;
  return jwt;
}

async function admin<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResult<T>> {
  return http<T>(`${DEV.strapi}${path}`, { ...init, headers: bearer(await adminJwt()) });
}

function expectStatus(res: HttpResult, ok: number[], what: string): void {
  if (!ok.includes(res.status)) throw new Error(`Strapi: ${what}に失敗（HTTP ${res.status}: ${res.text.slice(0, 200)}）`);
}

export interface ArticleInput {
  title: string;
  slug: string;
  description: string;
  body: string;
}

const articleData = (input: Partial<ArticleInput>): Record<string, unknown> => ({
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.slug !== undefined ? { slug: input.slug } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.body !== undefined ? { blocks: [{ __component: "shared.rich-text", body: input.body }] } : {}),
});

/** 記事の下書きを作る（content-writer・campaign-planner が strapi-prod の create_article で行うことの代わり）。documentId を返す */
export async function createDraftArticle(input: ArticleInput): Promise<string> {
  const res = await admin<{ data?: { documentId?: string } }>(`/content-manager/collection-types/${ARTICLE}`, { method: "POST", body: articleData(input) });
  expectStatus(res, [200, 201], "記事の下書きの作成");
  const documentId = res.json?.data?.documentId;
  if (!documentId) throw new Error("Strapi: 作った記事の documentId が無い");
  return documentId;
}

/** 記事の下書きを書き直す（content-writer の E-13 モードが strapi-prod の update_article で行うことの代わり） */
export async function updateDraftArticle(documentId: string, input: Partial<ArticleInput>): Promise<void> {
  const res = await admin(`/content-manager/collection-types/${ARTICLE}/${documentId}`, { method: "PUT", body: articleData(input) });
  expectStatus(res, [200], "記事の下書きの更新");
}

/** 記事を公開する（R2 が管理画面で行う操作。ADR-17） */
export async function publishArticle(documentId: string): Promise<void> {
  const res = await admin(`/content-manager/collection-types/${ARTICLE}/${documentId}/actions/publish`, { method: "POST", body: {} });
  expectStatus(res, [200, 201], "記事の公開");
}

/** 記事を消す（後片付け）。既に無ければ何もしない */
export async function deleteArticle(documentId: string): Promise<void> {
  const res = await admin(`/content-manager/collection-types/${ARTICLE}/${documentId}`, { method: "DELETE" });
  expectStatus(res, [200, 204, 404], "記事の削除");
}

/** Content API（読み取り専用トークン）で読んだ記事の cover（無ければ null） */
export async function articleCover(documentId: string, status: "draft" | "published"): Promise<{ id: number; url: string } | null> {
  const res = await http<{ data?: { cover?: { id: number; url: string } | null } }>(
    `${DEV.strapi}/api/articles/${documentId}?status=${status}&populate[cover]=true`,
    { headers: bearer(strapiReadToken()) },
  );
  if (res.status === 404) return null;
  expectStatus(res, [200], "記事の読み取り");
  return res.json?.data?.cover ?? null;
}

/** メディアライブラリのファイルを消す（後片付け。article-cover が上げた画像）。既に無ければ何もしない */
export async function deleteUploadFile(id: number): Promise<void> {
  const res = await admin(`/upload/files/${id}`, { method: "DELETE" });
  expectStatus(res, [200, 204, 404], "メディアの削除");
}

/**
 * テストの間だけの Content API のトークン（本番の CONTROL_STRAPI_WRITE_TOKEN と同じく、Upload の upload と Article の update だけ。公開・作成・削除は付けない）。
 * 開発の設定スクリプトはこのトークンを作らないため、テストが作って afterAll で消す。
 */
export async function createWriteToken(name: string): Promise<{ id: number; accessKey: string }> {
  const res = await admin<{ data?: { id?: number; accessKey?: string } }>("/admin/api-tokens", {
    method: "POST",
    body: {
      name,
      description: "結合テスト（改善ループ）の書き込みトークン。テストの後で消す",
      type: "custom",
      lifespan: null,
      permissions: ["plugin::upload.content-api.upload", "api::article.article.update"],
    },
  });
  expectStatus(res, [200, 201], "書き込みトークンの発行");
  const { id, accessKey } = res.json?.data ?? {};
  if (typeof id !== "number" || !accessKey) throw new Error("Strapi: 発行したトークンの id か accessKey が無い");
  return { id, accessKey };
}

export async function deleteApiToken(id: number): Promise<void> {
  const res = await admin(`/admin/api-tokens/${id}`, { method: "DELETE" });
  expectStatus(res, [200, 204, 404], "API トークンの削除");
}

// ---- Mautic ----

function expectMautic(res: HttpResult, what: string): void {
  if (res.status !== 200 && res.status !== 201) throw new Error(`Mautic: ${what}に失敗（HTTP ${res.status}: ${res.text.slice(0, 200)}）`);
}

/** 送信先のセグメント（本番では E-13 が既存のセグメントを指す。テストでは誰も入っていない it- のセグメントを作り、公開しても誰にも送られないようにする） */
export async function createSegment(name: string): Promise<number> {
  const res = await mauticApi<{ list?: { id?: number } }>("/segments/new", {
    method: "POST",
    body: { name, alias: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), isPublished: true, filters: [] },
  });
  expectMautic(res, "セグメントの作成");
  const id = res.json?.list?.id;
  if (typeof id !== "number") throw new Error("Mautic: 作ったセグメントの id が無い");
  return id;
}

/** campaign-planner の手順 3 のメールの入力（mautic_create_record の resources: emails。未公開・template・lists なし） */
export const templateEmailData = (input: { name: string; subject: string; html: string }): Record<string, unknown> => ({
  name: input.name,
  subject: input.subject,
  customHtml: input.html,
  emailType: "template",
  isPublished: false,
});

/** campaign-planner の手順 4 のキャンペーンの入力（resources: campaigns。未公開・email.send 1 つ・canvasSettings つき） */
export const campaignData = (input: { name: string; segmentId: number; emailId: number }): Record<string, unknown> => ({
  name: input.name,
  isPublished: false,
  lists: [{ id: input.segmentId }],
  events: [
    {
      id: "new_1",
      name: "メールを送る",
      type: "email.send",
      eventType: "action",
      order: 1,
      properties: { email: input.emailId, email_type: "marketing" },
      triggerMode: "immediate",
    },
  ],
  canvasSettings: {
    nodes: [
      { id: "lists", positionX: "600", positionY: "155" },
      { id: "new_1", positionX: "600", positionY: "317" },
    ],
    connections: [{ sourceId: "lists", targetId: "new_1", anchors: { source: "leadsource", target: "top" } }],
  },
});

/** mautic_create_record と同じ作成（POST /api/<resource>/new）。作ったものの id */
export async function createMauticRecord(resource: "emails" | "campaigns", data: Record<string, unknown>): Promise<number> {
  const key = resource === "emails" ? "email" : "campaign";
  const res = await mauticApi<Record<string, { id?: number; events?: { type?: string }[] }>>(`/${resource}/new`, { method: "POST", body: data });
  expectMautic(res, `${resource} の作成`);
  const record = res.json?.[key];
  if (typeof record?.id !== "number") throw new Error(`Mautic: 作った ${resource} の id が無い`);
  if (resource === "campaigns" && !(record.events ?? []).some((event) => event.type === "email.send")) {
    throw new Error("Mautic: キャンペーンにメールを送るイベント（email.send）が作られていない");
  }
  return record.id;
}

/** 公開する（人が Mautic の管理画面で行う操作。キャンペーンを公開した瞬間が送信の開始） */
export async function publishMauticRecord(resource: "emails" | "campaigns", id: number): Promise<void> {
  const res = await mauticApi(`/${resource}/${id}/edit`, { method: "PATCH", body: { isPublished: true } });
  expectMautic(res, `${resource} ${id} の公開`);
}

/** 消す（後片付け）。既に無ければ何もしない */
export async function deleteMauticRecord(resource: "emails" | "campaigns" | "segments", id: number): Promise<void> {
  const res = await mauticApi(`/${resource}/${id}/delete`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404) throw new Error(`Mautic: ${resource} ${id} を消せない（HTTP ${res.status}）`);
}
