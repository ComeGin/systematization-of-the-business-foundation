// 開発の Strapi（127.0.0.1:1337。strapi develop）を外から試すための補助。
//
//   STRAPI_BUILD_TOKEN  Content API の読み取り専用トークン（I-09。Astro のビルドが使う）
//   STRAPI_DEV_TOKEN    Admin トークン（I-16。strapi-mcp が使う。下書きまで＝作成・読み取り・更新だけ）
//   管理者              STRAPI_ADMIN_EMAIL・STRAPI_ADMIN_PASSWORD（dev.conf）。公開と後片付け（削除）にだけ使う。
//                       STRAPI_DEV_TOKEN には削除の権限が無いので、テストで作ったものは管理者で消す
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { requireValue } from "../helpers/env.ts";
import { http, type HttpResult } from "../helpers/http.ts";
import { DEV } from "../helpers/services.ts";

export const ARTICLE = "api::article.article";
export const KEYWORD = "api::keyword.keyword";
export const CONTENT_PLAN = "api::content-plan.content-plan";
export const CATEGORY = "api::category.category";

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
export const buildToken = (): string => requireValue("STRAPI_BUILD_TOKEN");
export const devToken = (): string => requireValue("STRAPI_DEV_TOKEN");

/** Content API（/api/*）。token を省くとトークン無し（Public ロール）で送る */
export async function contentApi<T = unknown>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<HttpResult<T>> {
  const { token, ...rest } = init;
  return http<T>(`${DEV.strapi}/api${path}`, { ...rest, headers: token ? bearer(token) : {} });
}

let jwt: string | undefined;

/** 管理者の JWT（ファイルの中でだけ使い回す）。パスワードは例外の文に出さない */
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

/** Content Manager の管理 API（/content-manager/collection-types/<uid>）。token を省くと管理者で送る */
export async function contentManager<T = unknown>(uid: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<HttpResult<T>> {
  const { token, ...rest } = init;
  return http<T>(`${DEV.strapi}/content-manager/collection-types/${uid}${path}`, { ...rest, headers: bearer(token ?? (await adminJwt())) });
}

/** 管理者で管理 API（/users-permissions/advanced など）を読む */
export async function adminApi<T = unknown>(path: string): Promise<HttpResult<T>> {
  return http<T>(`${DEV.strapi}${path}`, { headers: bearer(await adminJwt()) });
}

/** 管理者でドキュメントを作る（下書き）。documentId を返す */
export async function adminCreate(uid: string, data: Record<string, unknown>): Promise<string> {
  const res = await contentManager<{ data?: { documentId?: string } }>(uid, "", { method: "POST", body: data });
  if (res.status !== 201 || !res.json?.data?.documentId) throw new Error(`Strapi に ${uid} を作れない（HTTP ${res.status}: ${res.text.slice(0, 200)}）`);
  return res.json.data.documentId;
}

/** 管理者で公開する（R2 が管理画面で行う操作。ADR-17） */
export async function adminPublish(uid: string, documentId: string): Promise<void> {
  const res = await contentManager(uid, `/${documentId}/actions/publish`, { method: "POST", body: {} });
  if (res.status !== 200) throw new Error(`Strapi の ${uid} ${documentId} を公開できない（HTTP ${res.status}）`);
}

/** 管理者で削除する（後片付け）。既に無ければ何もしない */
export async function adminDelete(uid: string, documentId: string): Promise<void> {
  const res = await contentManager(uid, `/${documentId}`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404) throw new Error(`Strapi の ${uid} ${documentId} を消せない（HTTP ${res.status}）`);
}

/** strapi-mcp（Strapi の組み込みの /mcp）に MCP SDK の Client で繋ぐ。token を省くと認証ヘッダー無し */
export async function connectMcp(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${DEV.strapi}/mcp`), {
    requestInit: { headers: token ? bearer(token) : {} },
  });
  const client = new Client({ name: "it-strapi", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export interface ToolOutcome<T = unknown> {
  isError: boolean;
  text: string;
  data: T | undefined;
}

/** ツールを呼び、本文のテキストと structuredContent.data をまとめて返す（isError は投げずに返す） */
export async function callTool<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome<T>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { data?: T };
  };
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  return { isError: res.isError === true, text, data: res.structuredContent?.data };
}
