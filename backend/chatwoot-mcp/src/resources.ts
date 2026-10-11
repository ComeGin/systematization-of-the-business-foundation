/**
 * chatwoot_list_records / chatwoot_get_record / chatwoot_create_record / chatwoot_update_record / chatwoot_delete_record で扱う
 * アカウント設定系のリソース定義。
 *
 * Chatwoot はリソースごとにレスポンスの形が異なる（配列 / { payload: [...] } / { payload: { webhooks: [...] } }）ため、
 * 取り出し方を shape で指定する。
 * wrap は書き込み時にリクエスト本文を包むキー。コントローラが params.require(:label) のように要求するもので、
 * Rails の自動ラップはモデル属性名のキーしか包まないため、明示的に包んで送る。
 */
import type { ApiRecord } from "./types.js";

type Shape = "array" | "payload" | "payload.webhooks";

export interface ResourceDefinition {
  path: string;
  description: string;
  /** 一覧のレスポンスの形。undefined なら一覧 API なし */
  list?: Shape;
  /** 1 件取得のレスポンスの形。"from_list" は取得 API がないため一覧から ID で探す */
  get?: "plain" | "payload" | "from_list";
  /** 一覧の要約に出す項目（id と名前は自動で含める） */
  summary: string[];
  /** 名前として表示する項目 */
  nameKey: string;
  wrap?: string;
  create?: boolean;
  update?: boolean;
  delete?: boolean;
  /** 更新・削除の ID の代わりに使う値（ポータルは slug で指定する） */
  idLabel?: string;
  /** 親リソース配下に作成するもの（parent_id が必要） */
  parent?: { label: string; path: (parentId: string) => string };
  /** 作成時の data の例（ツールの説明に載せる） */
  example?: string;
  notes?: string;
}

export const RESOURCES = {
  agents: {
    path: "/agents",
    description: "Agents (users) in the account with role and availability",
    list: "array",
    get: "from_list",
    summary: ["email", "role", "availability_status", "confirmed"],
    nameKey: "available_name",
    wrap: "agent",
    create: true,
    update: true,
    delete: true,
    example: '{"name":"Hanako Sato","email":"hanako@example.com","role":"agent"}',
    notes: "Creating an agent sends an invitation email. Update accepts role, availability, auto_offline.",
  },
  inboxes: {
    path: "/inboxes",
    description: "Inboxes (channels: website widget, email, API, LINE, WhatsApp...)",
    list: "payload",
    get: "plain",
    summary: ["channel_type", "website_url", "email", "enable_auto_assignment", "working_hours_enabled", "greeting_enabled"],
    nameKey: "name",
    create: true,
    update: true,
    example: '{"name":"Inquiry API","channel":{"type":"api","webhook_url":""}}',
    notes: "channel.type: web_widget (website_url, widget_color), api (webhook_url), email (email). Channel settings are updated inside channel.",
  },
  labels: {
    path: "/labels",
    description: "Labels used to tag conversations and contacts",
    list: "payload",
    get: "plain",
    summary: ["description", "color", "show_on_sidebar"],
    nameKey: "title",
    wrap: "label",
    create: true,
    update: true,
    delete: true,
    example: '{"title":"billing","description":"Billing questions","color":"#1F93FF","show_on_sidebar":true}',
    notes: "title: lowercase letters, digits, '-' and '_' only.",
  },
  teams: {
    path: "/teams",
    description: "Teams that conversations can be assigned to (members: chatwoot_get_related)",
    list: "array",
    get: "plain",
    summary: ["description", "allow_auto_assign"],
    nameKey: "name",
    wrap: "team",
    create: true,
    update: true,
    delete: true,
    example: '{"name":"sales","description":"Pre-sales inquiries","allow_auto_assign":true}',
  },
  canned_responses: {
    path: "/canned_responses",
    description: "Canned responses (saved reply templates, inserted with /short_code)",
    list: "array",
    get: "from_list",
    summary: ["short_code", "content"],
    nameKey: "short_code",
    wrap: "canned_response",
    create: true,
    update: true,
    delete: true,
    example: '{"short_code":"thanks","content":"お問い合わせありがとうございます。"}',
  },
  custom_attribute_definitions: {
    path: "/custom_attribute_definitions",
    description: "Custom attribute definitions for conversations or contacts (filter with attribute_model)",
    list: "array",
    get: "plain",
    summary: ["attribute_key", "attribute_model", "attribute_display_type", "attribute_values", "attribute_description"],
    nameKey: "attribute_display_name",
    wrap: "custom_attribute_definition",
    create: true,
    update: true,
    delete: true,
    example:
      '{"attribute_display_name":"Plan","attribute_key":"plan","attribute_display_type":"list","attribute_values":["free","pro"],"attribute_model":"contact_attribute"}',
    notes: "attribute_display_type: text, number, currency, percent, link, date, list, checkbox. attribute_model: conversation_attribute or contact_attribute.",
  },
  automation_rules: {
    path: "/automation_rules",
    description: "Automation rules (event + conditions -> actions)",
    list: "payload",
    get: "payload",
    summary: ["event_name", "active", "description"],
    nameKey: "name",
    create: true,
    update: true,
    delete: true,
    example:
      '{"name":"Tag billing","event_name":"message_created","active":true,"conditions":[{"attribute_key":"content","filter_operator":"contains","values":["請求"],"query_operator":null}],"actions":[{"action_name":"add_label","action_params":["billing"]}]}',
    notes:
      "event_name: conversation_created, conversation_updated, conversation_resolved, message_created. action_name examples: add_label, assign_team, assign_agent, send_message, resolve_conversation, mute_conversation.",
  },
  custom_filters: {
    path: "/custom_filters",
    description: "Saved filters (views) of conversations / contacts (filter with filter_type)",
    list: "array",
    get: "plain",
    summary: ["filter_type", "query"],
    nameKey: "name",
    wrap: "custom_filter",
    create: true,
    update: true,
    delete: true,
    example: '{"name":"Urgent open","filter_type":"conversation","query":{"payload":[{"attribute_key":"priority","filter_operator":"equal_to","values":["urgent"]}]}}',
    notes: "filter_type: conversation, contact, report. Saved filters belong to the token's user.",
  },
  webhooks: {
    path: "/webhooks",
    description: "Account webhooks (URL + subscribed events)",
    list: "payload.webhooks",
    get: "from_list",
    summary: ["url", "subscriptions", "inbox"],
    nameKey: "name",
    wrap: "webhook",
    create: true,
    update: true,
    delete: true,
    example: '{"name":"CRM sync","url":"https://example.com/chatwoot","subscriptions":["conversation_created","message_created"]}',
    notes:
      "subscriptions: conversation_created, conversation_status_changed, conversation_updated, contact_created, contact_updated, message_created, message_updated, webwidget_triggered, conversation_typing_on, conversation_typing_off.",
  },
  agent_bots: {
    path: "/agent_bots",
    description: "Agent bots (webhook-based bots that can answer conversations)",
    list: "array",
    get: "plain",
    summary: ["description", "outgoing_url", "bot_type", "system_bot"],
    nameKey: "name",
    create: true,
    update: true,
    delete: true,
    example: '{"name":"FAQ bot","description":"Answers FAQs","outgoing_url":"https://example.com/bot"}',
    notes: "Attach a bot to an inbox with chatwoot_set_inbox_agent_bot.",
  },
  integration_apps: {
    path: "/integrations/apps",
    description: "Available integrations (Slack, Dialogflow, webhooks...) with enabled state and configured hooks",
    list: "payload",
    get: "from_list",
    summary: ["description", "enabled", "hooks"],
    nameKey: "name",
  },
  integration_hooks: {
    path: "/integrations/hooks",
    description: "Configured integration hooks (write only; list them via integration_apps)",
    summary: [],
    nameKey: "app_id",
    wrap: "hook",
    create: true,
    update: true,
    delete: true,
    example: '{"app_id":"dialogflow","inbox_id":1,"settings":{"project_id":"..."}}',
    notes: "Update accepts status (0 inactive / 1 active) and settings.",
  },
  portals: {
    path: "/portals",
    description: "Help center portals",
    list: "payload",
    get: "from_list",
    summary: ["slug", "custom_domain", "archived", "config"],
    nameKey: "name",
    wrap: "portal",
    create: true,
    update: true,
    idLabel: "Portal slug",
    example: '{"name":"ComeGin Help","slug":"help","color":"#1F93FF","config":{"allowed_locales":["ja"],"default_locale":"ja"}}',
    notes: "Update / parent_id use the portal slug instead of a numeric ID.",
  },
  portal_categories: {
    path: "/categories",
    description: "Help center categories (create only; parent_id = portal slug)",
    summary: [],
    nameKey: "name",
    wrap: "category",
    create: true,
    parent: { label: "Portal slug", path: (slug) => `/portals/${encodeURIComponent(slug)}/categories` },
    example: '{"name":"Billing","slug":"billing","locale":"ja"}',
  },
  portal_articles: {
    path: "/articles",
    description: "Help center articles (create only; parent_id = portal slug)",
    summary: [],
    nameKey: "title",
    wrap: "article",
    create: true,
    parent: { label: "Portal slug", path: (slug) => `/portals/${encodeURIComponent(slug)}/articles` },
    example: '{"title":"How to pay","content":"...","category_id":1,"author_id":1,"status":0,"locale":"ja"}',
    notes: "status: 0 draft, 1 published, 2 archived.",
  },
} satisfies Record<string, ResourceDefinition>;

export type ResourceName = keyof typeof RESOURCES;

function namesWhere(predicate: (resource: ResourceDefinition) => boolean): [ResourceName, ...ResourceName[]] {
  return (Object.keys(RESOURCES) as ResourceName[]).filter((name) => predicate(RESOURCES[name])) as [ResourceName, ...ResourceName[]];
}

export const LISTABLE = namesWhere((r) => r.list !== undefined);
export const GETTABLE = namesWhere((r) => r.get !== undefined);
export const CREATABLE = namesWhere((r) => r.create === true);
export const UPDATABLE = namesWhere((r) => r.update === true);
export const DELETABLE = namesWhere((r) => r.delete === true);

export function getResource(name: ResourceName): ResourceDefinition {
  return RESOURCES[name];
}

/** リソースの一覧レスポンスから要素の配列を取り出す */
export function extractList(shape: Shape, data: unknown): ApiRecord[] {
  const value =
    shape === "array"
      ? data
      : shape === "payload"
        ? (data as { payload?: unknown } | null)?.payload
        : (data as { payload?: { webhooks?: unknown } } | null)?.payload?.webhooks;
  return Array.isArray(value) ? (value as ApiRecord[]) : [];
}

/** 書き込み API のレスポンスから対象レコードを取り出す（{ payload: {...} } で返すものがある） */
export function unwrapRecord(data: unknown): ApiRecord {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const record = data as ApiRecord;
    const payload = record.payload;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload) && Object.keys(record).length === 1) {
      return payload as ApiRecord;
    }
    return record;
  }
  return { result: data };
}
