import { createHmac } from "node:crypto";

/** Chatwoot と同じ署名（lib/webhooks/trigger.rb: sha256=HMAC-SHA256(secret, "<ts>.<body>")） */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** message_created（訪問者の発言）の Webhook の本文。Message#webhook_data の形 */
export function questionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "message_created",
    id: 101,
    content: "料金は税込ですか？",
    message_type: "incoming",
    content_type: "text",
    content_attributes: {},
    private: false,
    sender: { id: 7, name: "it-visitor", type: "contact" },
    account: { id: 1, name: "ComeGin" },
    conversation: { id: 12, status: "pending" },
    inbox: { id: 3, name: "Web サイト" },
    ...overrides,
  };
}

/** message_updated（訪問者がボットの input_select を選んだ）の本文 */
export function selectionPayload(value: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return questionPayload({
    event: "message_updated",
    id: 205,
    content: "次のどれに近いですか？",
    message_type: "outgoing",
    content_type: "input_select",
    content_attributes: { items: [{ title: "t", value }], submitted_values: [{ title: "t", value }] },
    sender: { id: 2, name: "FAQ ボット", type: "agent_bot" },
    ...overrides,
  });
}

/** webwidget_triggered（訪問者がウィジェットを開いた）の本文。ContactInbox#webhook_data ＋ event・event_info の形 */
export function welcomePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "webwidget_triggered",
    id: 55,
    contact: { id: 7, name: "it-visitor" },
    inbox: { id: 3, name: "Web サイト" },
    account: { id: 1, name: "ComeGin" },
    current_conversation: null,
    source_id: "3f1c2b9e-0000-4000-8000-000000000000",
    event_info: { widget_language: "ja", browser_language: "ja" },
    ...overrides,
  };
}

/** conversation_updated（会話の更新。ラベルの変更など）の本文。会話の webhook_data ＋ event・changed_attributes の形 */
export function conversationUpdatedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "conversation_updated",
    id: 12,
    status: "open",
    inbox_id: 3,
    labels: ["faq-handoff", "faq-ask-resolved"],
    account: { id: 1, name: "ComeGin" },
    changed_attributes: [{ label_list: { previous_value: ["faq-handoff"], current_value: ["faq-handoff", "faq-ask-resolved"] } }],
    ...overrides,
  };
}

/** conversation_updated の changed_attributes（Chatwoot の BaseListener#extract_changed_attributes の形）で、ラベルの前後を表す */
export function labelChange(previous: string[], current: string[]): Record<string, unknown>[] {
  return [{ label_list: { previous_value: previous, current_value: current } }];
}
