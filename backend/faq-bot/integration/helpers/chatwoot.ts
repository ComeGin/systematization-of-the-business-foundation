import { CHATWOOT, type DevState } from "./state.js";

export interface WidgetMessage {
  id: number;
  content: string | null;
  message_type: number;
  content_type: string;
  content_attributes: { items?: { title: string; value: string }[]; submitted_values?: unknown[] } | null;
  conversation_id: number;
}

async function ok<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** ウィジェットの公開 API で振る舞う訪問者（I-07 と同じ経路） */
export class Visitor {
  private constructor(
    private readonly state: DevState,
    private readonly auth: string,
    readonly contactId: number,
  ) {}

  static async create(state: DevState, name: string): Promise<Visitor> {
    const config = await ok<{ website_channel_config: { auth_token: string }; contact: { id: number } }>(
      await fetch(`${CHATWOOT}/api/v1/widget/config?website_token=${state.websiteToken}`, { method: "POST" }),
      "widget config",
    );
    const visitor = new Visitor(state, config.website_channel_config.auth_token, config.contact.id);
    // 消し残しを探せるように it- の名前を付ける
    await ok(await fetch(visitor.url("/api/v1/widget/contact"), { method: "PATCH", headers: visitor.headers(), body: JSON.stringify({ name }) }), "widget contact");
    return visitor;
  }

  private url(path: string): string {
    return `${CHATWOOT}${path}?website_token=${this.state.websiteToken}`;
  }

  private headers(): Record<string, string> {
    return { "X-Auth-Token": this.auth, "Content-Type": "application/json" };
  }

  /** バブルを開いたのと同じ（SDK の onBubbleToggle → POST /api/v1/widget/events。Chatwoot がボットに webwidget_triggered を送る） */
  async open(): Promise<void> {
    await ok(await fetch(this.url("/api/v1/widget/events"), { method: "POST", headers: this.headers(), body: JSON.stringify({ name: "webwidget.triggered", event_info: {} }) }), "widget event");
  }

  async say(content: string): Promise<{ id: number; conversation_id: number }> {
    return ok(await fetch(this.url("/api/v1/widget/messages"), { method: "POST", headers: this.headers(), body: JSON.stringify({ message: { content, timestamp: new Date().toString() } }) }), "widget message");
  }

  async messages(): Promise<WidgetMessage[]> {
    const body = await ok<{ payload: WidgetMessage[] }>(await fetch(this.url("/api/v1/widget/messages"), { headers: this.headers() }), "widget messages");
    return body.payload;
  }

  async select(messageId: number, item: { title: string; value: string }): Promise<void> {
    await ok(await fetch(this.url(`/api/v1/widget/messages/${messageId}`), { method: "PATCH", headers: this.headers(), body: JSON.stringify({ message: { submitted_values: [item] } }) }), "widget select");
  }
}

/** 管理者のトークンで会話を読む・後片付けする */
export class Admin {
  constructor(private readonly state: DevState) {}

  private url(path: string): string {
    return `${CHATWOOT}/api/v1/accounts/${this.state.accountId}${path}`;
  }

  async conversation(id: number): Promise<{ status: string; labels: string[] }> {
    const body = await ok<{ status: string; labels: string[] }>(await fetch(this.url(`/conversations/${id}`), { headers: { api_access_token: this.state.adminToken } }), "conversation");
    return { status: body.status, labels: body.labels ?? [] };
  }

  /** ラベルを付け替える（マクロ「解決の確認を送る」はラベル faq-ask-resolved を足すだけなので、同じ結果になる） */
  async setLabels(id: number, labels: string[]): Promise<void> {
    await ok(await fetch(this.url(`/conversations/${id}/labels`), { method: "POST", headers: { api_access_token: this.state.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ labels }) }), "labels");
  }

  /** 担当者の公開の返信（管理画面の返信欄と同じ） */
  async reply(id: number, content: string): Promise<void> {
    await ok(await fetch(this.url(`/conversations/${id}/messages`), { method: "POST", headers: { api_access_token: this.state.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ content, message_type: "outgoing", private: false }) }), "reply");
  }

  /** 会話のステータスを変える（管理画面の「解決」「再開」「スヌーズ」と同じ） */
  async setStatus(id: number, status: "open" | "resolved" | "snoozed"): Promise<void> {
    await ok(await fetch(this.url(`/conversations/${id}/toggle_status`), { method: "POST", headers: { api_access_token: this.state.adminToken, "Content-Type": "application/json" }, body: JSON.stringify({ status }) }), "toggle_status");
  }

  async deleteContact(id: number): Promise<void> {
    await fetch(this.url(`/contacts/${id}`), { method: "DELETE", headers: { api_access_token: this.state.adminToken } });
  }
}

/** 条件を満たすまで待つ（Webhook は Sidekiq のジョブなので非同期） */
export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`待ちきれなかった: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** ボットの最新の input_select（または text）を待つ */
export const botMessage = (visitor: Visitor, predicate: (m: WidgetMessage) => boolean, label: string) =>
  waitFor(async () => (await visitor.messages()).filter((m) => m.message_type === 1).find(predicate), label);
