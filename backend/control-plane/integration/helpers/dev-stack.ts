// 開発スタック（127.0.0.1 の n8n・Chatwoot）の値と、Chatwoot のテストデータの作成。
// 値は W/integration の共通ヘルパー（状態ファイル ~/.config/comegin/setup/dev.state.json）から実行時に読む。秘密値は画面に出さない。
import { chatwootApi } from "../../../../integration/tests/helpers/chatwoot.ts";
import { requireValue } from "../../../../integration/tests/helpers/env.ts";
import { itEmail, itName } from "../../../../integration/tests/helpers/run-id.ts";
import { DEV } from "../../../../integration/tests/helpers/services.ts";

export { Cleanup } from "../../../../integration/tests/helpers/cleanup.ts";
export { deleteChatwootContact, deleteChatwootConversation } from "../../../../integration/tests/helpers/chatwoot.ts";
export { RUN_ID, itName } from "../../../../integration/tests/helpers/run-id.ts";
export { requireValue, DEV };

/** どこにも開いていないポート（届かない上流の代わり） */
export const CLOSED_PORT_URL = "http://127.0.0.1:9";

/** n8n-export の設定（開発の n8n の公開 API を読むだけ。書き込まない） */
export const n8nExportEnv = (): Record<string, string> => ({
  CONTROL_N8N_EXPORT_URL: DEV.n8n,
  CONTROL_N8N_EXPORT_API_KEY: requireValue("N8N_API_KEY"),
});

/**
 * 突き合わせの設定。開発では「参照専用トークン」の代わりに管理者のトークンで読む（全会話が見える）。
 * MISWRITE_AGENT_USER_ID はエージェント専用ユーザー（CHATWOOT_AGENT_TOKEN の持ち主）
 */
export const miswriteEnv = (): Record<string, string> => ({
  MISWRITE_CHATWOOT_BASE_URL: DEV.chatwoot,
  MISWRITE_CHATWOOT_ACCOUNT_ID: requireValue("CHATWOOT_ACCOUNT_ID"),
  MISWRITE_CHATWOOT_API_TOKEN: requireValue("CHATWOOT_ADMIN_TOKEN"),
  MISWRITE_AGENT_USER_ID: requireValue("CHATWOOT_AGENT_USER_ID"),
});

/** 開発の Chatwoot の受信箱に、it- のコンタクトと会話を作る（管理者）。会話の id が display_id */
export async function createItConversation(label: string): Promise<{ contactId: number; displayId: number }> {
  const inboxId = Number(requireValue("CHATWOOT_INBOX_ID"));
  const contact = await chatwootApi<{ payload: { contact: { id: number; contact_inboxes: { source_id: string }[] } } }>("/contacts", {
    method: "POST",
    body: { name: itName(label), email: itEmail(label), inbox_id: inboxId },
  });
  const created = contact.json?.payload.contact;
  const sourceId = created?.contact_inboxes[0]?.source_id;
  if (contact.status !== 200 || !created || !sourceId) throw new Error(`Chatwoot のコンタクトを作れない（HTTP ${contact.status}）`);
  const conversation = await chatwootApi<{ id: number }>("/conversations", {
    method: "POST",
    body: { source_id: sourceId, inbox_id: inboxId, contact_id: created.id },
  });
  if (conversation.status !== 200 || !conversation.json) throw new Error(`Chatwoot の会話を作れない（HTTP ${conversation.status}）`);
  return { contactId: created.id, displayId: conversation.json.id };
}

/** エージェント専用ユーザーのトークンで社内メモ（private の outgoing）を送る。メッセージの id を返す */
export async function sendAgentNote(displayId: number, content: string): Promise<number> {
  const res = await chatwootApi<{ id: number; message_type: number }>(`/conversations/${displayId}/messages`, {
    method: "POST",
    actor: "agent",
    body: { content, message_type: "outgoing", private: true },
  });
  if (res.status !== 200 || !res.json) throw new Error(`社内メモを送れない（HTTP ${res.status}）`);
  return res.json.id;
}
