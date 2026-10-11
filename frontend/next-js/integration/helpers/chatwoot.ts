// 開発の Chatwoot（127.0.0.1:3100）。誤った書き込みの突き合わせ（builtin miswrite-check）が読む会話とメッセージを、テストの間だけ作る。
// 値は設定スクリプトの状態ファイル（~/.config/comegin/setup/dev.state.json）から読む。秘密値は返すだけで、画面・例外の文に出さない。
// integration/tests/helpers/chatwoot.ts と同じ考え方（next-js の tsconfig から .ts 付きの import を読めないため、ここに小さく持つ）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHATWOOT_URL = "http://127.0.0.1:3100";
const STATE_FILE = join(homedir(), ".config/comegin/setup/dev.state.json");

let cache: Record<string, string> | undefined;

/** 状態ファイルの値。無ければ例外（キーの名前だけを出す） */
export function stateValue(key: string): string {
  cache ??= Object.fromEntries(
    Object.entries((JSON.parse(readFileSync(STATE_FILE, "utf8")) as { values?: Record<string, unknown> }).values ?? {}).map(
      ([k, v]) => [k, String(v)],
    ),
  );
  const value = cache[key];
  if (!value) throw new Error(`${key} が ${STATE_FILE} に無い（node setup/setup.mjs --target dev を先に済ませる）`);
  return value;
}

type Actor = "admin" | "agent";

async function api<T>(path: string, init: { method?: string; body?: unknown; actor?: Actor } = {}): Promise<{ status: number; json: T }> {
  const { method = "GET", body, actor = "admin" } = init;
  const res = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${stateValue("CHATWOOT_ACCOUNT_ID")}${path}`, {
    method,
    headers: {
      api_access_token: stateValue(actor === "admin" ? "CHATWOOT_ADMIN_TOKEN" : "CHATWOOT_AGENT_TOKEN"),
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

/** コンタクトと会話を作る（Web ウィジェットの受信箱。外には何も送られない）。戻り値の displayId は画面の #番号 */
export async function createConversation(name: string, email: string): Promise<{ contactId: number; displayId: number }> {
  const inboxId = Number(stateValue("CHATWOOT_INBOX_ID"));
  const contact = await api<{ payload?: { contact?: { id: number }; contact_inbox?: { source_id: string } } }>("/contacts", {
    method: "POST",
    body: { inbox_id: inboxId, name, email },
  });
  const contactId = contact.json?.payload?.contact?.id;
  const sourceId = contact.json?.payload?.contact_inbox?.source_id;
  if (contact.status !== 200 || !contactId || !sourceId) throw new Error(`Chatwoot のコンタクトを作れない（HTTP ${contact.status}）`);
  const conversation = await api<{ id?: number }>("/conversations", {
    method: "POST",
    body: { source_id: sourceId, inbox_id: inboxId, contact_id: contactId },
  });
  if (conversation.status !== 200 || !conversation.json?.id) throw new Error(`Chatwoot の会話を作れない（HTTP ${conversation.status}）`);
  return { contactId, displayId: conversation.json.id };
}

/** 送信（outgoing）のメッセージ。actor=agent はエージェント専用ユーザー（ADR-17）としての送信 */
export async function sendOutgoing(displayId: number, content: string, actor: Actor): Promise<number> {
  const res = await api<{ id?: number }>(`/conversations/${displayId}/messages`, {
    method: "POST",
    actor,
    body: { content, message_type: "outgoing", private: false },
  });
  if (res.status !== 200 || !res.json?.id) throw new Error(`Chatwoot にメッセージを送れない（HTTP ${res.status}）`);
  return res.json.id;
}

/** 会話の削除は管理者だけ。コンタクトを消しても会話は残るため、両方を消す */
export async function deleteConversationAndContact(displayId: number, contactId: number): Promise<void> {
  const conversation = await api(`/conversations/${displayId}`, { method: "DELETE" });
  const contact = await api(`/contacts/${contactId}`, { method: "DELETE" });
  for (const [what, status] of [
    [`会話 ${displayId}`, conversation.status],
    [`コンタクト ${contactId}`, contact.status],
  ] as const) {
    if (![200, 204, 404].includes(status)) throw new Error(`Chatwoot の${what}を消せない（HTTP ${status}）`);
  }
}
