// 開発の Chatwoot の REST API。管理者のトークン（CHATWOOT_ADMIN_TOKEN）は準備と後片付けに、
// エージェント専用ユーザーのトークン（CHATWOOT_AGENT_TOKEN。ADR-17）は chatwoot-mcp と同じ権限での確認に使う。
import { requireValue } from "./env.ts";
import { http, type HttpResult } from "./http.ts";
import { DEV } from "./services.ts";

export type ChatwootActor = "admin" | "agent";

export const chatwootAccountId = (): string => requireValue("CHATWOOT_ACCOUNT_ID");

export async function chatwootApi<T = unknown>(path: string, init: { method?: string; body?: unknown; actor?: ChatwootActor } = {}): Promise<HttpResult<T>> {
  const { actor = "admin", ...rest } = init;
  const accessToken = requireValue(actor === "admin" ? "CHATWOOT_ADMIN_TOKEN" : "CHATWOOT_AGENT_TOKEN");
  return http<T>(`${DEV.chatwoot}/api/v1/accounts/${chatwootAccountId()}${path}`, { ...rest, headers: { api_access_token: accessToken, accept: "application/json" } });
}

/**
 * 公開サイトのチャットウィジェットと同じ入口（I-07）。Public API（/public/api/v1/inboxes/:id）は API チャネルの identifier しか
 * 受けず、Web サイト受信箱の website_token では 404 になるため、ウィジェットの API（/api/v1/widget/*）を使う。
 * config で訪問者の auth_token（X-Auth-Token）を受け取り、以後の呼び出しに付ける。
 */
export async function chatwootWidgetSession(): Promise<{ call: <T = unknown>(path: string, init?: { method?: string; body?: unknown }) => Promise<HttpResult<T>> }> {
  const websiteToken = requireValue("CHATWOOT_WEBSITE_TOKEN");
  const url = (path: string) => `${DEV.chatwoot}/api/v1/widget${path}${path.includes("?") ? "&" : "?"}website_token=${encodeURIComponent(websiteToken)}`;
  const config = await http<{ website_channel_config?: { auth_token?: string } }>(url("/config"), { method: "POST" });
  const authToken = config.json?.website_channel_config?.auth_token;
  if (config.status !== 200 || !authToken) throw new Error(`Chatwoot のウィジェットの設定を取れない（HTTP ${config.status}）`);
  return {
    call: (path, init = {}) => http(url(path), { ...init, headers: { "X-Auth-Token": authToken, accept: "application/json" } }),
  };
}

export async function deleteChatwootContact(id: number): Promise<void> {
  const res = await chatwootApi(`/contacts/${id}`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404) throw new Error(`Chatwoot のコンタクト ${id} を消せない（HTTP ${res.status}）`);
}

/** 会話の削除は管理者だけ（Chatwoot 4 系）。コンタクトを消しても会話は残るため、会話も消す */
export async function deleteChatwootConversation(displayId: number): Promise<void> {
  const res = await chatwootApi(`/conversations/${displayId}`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 204 && res.status !== 404) throw new Error(`Chatwoot の会話 ${displayId} を消せない（HTTP ${res.status}）`);
}
