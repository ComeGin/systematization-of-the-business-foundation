/**
 * mautic_list_records / mautic_get_record で扱う Mautic の標準エンティティ API の定義。
 * one / multi は API レスポンスのキー名（各 ApiController の entityNameOne / entityNameMulti）。
 * summary は一覧に出す項目（ドット区切りでネストを指定）。共通項目（id, 名前, 公開状態, カテゴリ, 日時）は自動で含める。
 */
export interface ResourceDefinition {
  path: string;
  one: string;
  multi: string;
  description: string;
  summary: string[];
  /** false の場合、mautic_get_record では扱わない（専用ツールへ誘導する） */
  gettable?: false;
  getHint?: string;
}

export const RESOURCES = {
  assets: {
    path: "/assets",
    one: "asset",
    multi: "assets",
    description: "Downloadable files (PDFs, etc.) with download counts",
    summary: ["alias", "extension", "downloadCount", "uniqueDownloadCount"],
  },
  campaigns: {
    path: "/campaigns",
    one: "campaign",
    multi: "campaigns",
    description: "Automation campaigns (use mautic_list_campaign_contacts for members)",
    summary: ["description", "publishUp", "publishDown"],
  },
  campaign_events: {
    path: "/campaigns/events",
    one: "event",
    multi: "events",
    description: "Individual actions/decisions/conditions inside campaigns",
    summary: ["type", "eventType", "channel", "campaign.name"],
  },
  categories: {
    path: "/categories",
    one: "category",
    multi: "categories",
    description: "Categories used to group emails, assets, pages, etc. ('bundle' tells which)",
    summary: ["alias", "bundle", "color"],
  },
  companies: {
    path: "/companies",
    one: "company",
    multi: "companies",
    description: "Company (account) records",
    summary: ["fields.all.companyemail", "fields.all.companycity", "fields.all.companycountry", "fields.all.companyindustry", "score"],
  },
  contact_fields: {
    path: "/fields/contact",
    one: "field",
    multi: "fields",
    description: "Custom field definitions for contacts (alias, type, group)",
    summary: ["alias", "type", "group", "isRequired", "isUniqueIdentifier"],
  },
  company_fields: {
    path: "/fields/company",
    one: "field",
    multi: "fields",
    description: "Custom field definitions for companies",
    summary: ["alias", "type", "group", "isRequired"],
  },
  dynamic_content: {
    path: "/dynamiccontents",
    one: "dynamicContent",
    multi: "dynamicContents",
    description: "Dynamic web content blocks and their slots",
    summary: ["type", "slotName", "isCampaignBased", "sentCount"],
  },
  emails: {
    path: "/emails",
    one: "email",
    multi: "emails",
    description: "Email templates/broadcasts with sent and read counts",
    summary: ["subject", "emailType", "language", "sentCount", "readCount", "publishUp"],
  },
  focus: {
    path: "/focus",
    one: "focus",
    multi: "focus",
    description: "Focus items (website popups, bars, modals)",
    summary: ["type", "style", "website"],
  },
  forms: {
    path: "/forms",
    one: "form",
    multi: "forms",
    description: "Forms (use mautic_list_form_submissions for submitted data)",
    summary: ["alias", "formType"],
  },
  marketing_messages: {
    path: "/messages",
    one: "message",
    multi: "messages",
    description: "Marketing messages sent through multiple channels",
    summary: ["description"],
  },
  notes: {
    path: "/notes",
    one: "note",
    multi: "notes",
    description: "Notes attached to contacts (text, type, dateTime, lead)",
    summary: ["type", "text", "dateTime", "lead.id"],
  },
  notifications: {
    path: "/notifications",
    one: "notification",
    multi: "notifications",
    description: "Web push notifications with sent and read counts",
    summary: ["heading", "url", "sentCount", "readCount"],
  },
  pages: {
    path: "/pages",
    one: "page",
    multi: "pages",
    description: "Landing pages with hit counts",
    summary: ["alias", "language", "hits", "uniqueHits"],
  },
  point_actions: {
    path: "/points",
    one: "point",
    multi: "points",
    description: "Point actions: rules that add/subtract contact points (type, delta)",
    summary: ["type", "delta", "repeatable"],
  },
  point_groups: {
    path: "/points/groups",
    one: "pointGroup",
    multi: "pointGroups",
    description: "Point groups for scoring contacts separately per topic",
    summary: ["description"],
  },
  point_insights: {
    path: "/points/insights",
    one: "insight",
    multi: "insights",
    description: "Point insights definitions",
    summary: ["insightType", "insightAction", "customField"],
  },
  point_triggers: {
    path: "/points/triggers",
    one: "trigger",
    multi: "triggers",
    description: "Point triggers: actions fired when a contact reaches a point threshold",
    summary: ["points", "color", "triggerExistingLeads"],
  },
  reports: {
    path: "/reports",
    one: "report",
    multi: "reports",
    description: "Saved reports (run one with mautic_run_report)",
    summary: ["source", "system", "isScheduled"],
    gettable: false,
    getHint: "Use mautic_run_report to get a report's definition and data.",
  },
  roles: {
    path: "/roles",
    one: "role",
    multi: "roles",
    description: "User roles and their permissions",
    summary: ["description", "isAdmin"],
  },
  segments: {
    path: "/segments",
    one: "list",
    multi: "lists",
    description: "Contact segments (lists); 'alias' is used in contact search as segment:<alias>",
    summary: ["alias", "publicName", "isGlobal"],
  },
  stages: {
    path: "/stages",
    one: "stage",
    multi: "stages",
    description: "Lifecycle stages with weight",
    summary: ["weight", "description"],
  },
  tags: {
    path: "/tags",
    one: "tag",
    multi: "tags",
    description: "Contact tags",
    summary: ["description"],
  },
  text_messages: {
    path: "/smses",
    one: "sms",
    multi: "smses",
    description: "SMS text messages with sent counts",
    summary: ["message", "language", "sentCount"],
  },
  tweets: {
    path: "/tweets",
    one: "tweet",
    multi: "tweets",
    description: "Tweets used in social campaigns",
    summary: ["text", "sentCount", "favoriteCount", "retweetCount"],
  },
  users: {
    path: "/users",
    one: "user",
    multi: "users",
    description: "Mautic users (staff accounts) and their roles",
    summary: ["username", "email", "role.name", "lastLogin"],
  },
  webhooks: {
    path: "/hooks",
    one: "hook",
    multi: "hooks",
    description: "Webhooks and the URLs they post to (secrets are redacted)",
    summary: ["webhookUrl", "triggers"],
  },
} as const satisfies Record<string, ResourceDefinition>;

export type ResourceName = keyof typeof RESOURCES;

export const RESOURCE_NAMES = Object.keys(RESOURCES) as [ResourceName, ...ResourceName[]];

export function getResource(name: ResourceName): ResourceDefinition {
  return RESOURCES[name];
}

/** 書き込み（作成・更新・削除）の対象。参照用の RESOURCES に contacts を加えたもの */
export const WRITABLE_RESOURCES = {
  contacts: { path: "/contacts", one: "contact" },
  ...Object.fromEntries(Object.entries(RESOURCES).map(([name, { path, one }]) => [name, { path, one }])),
} as Record<WritableResourceName, { path: string; one: string }>;

export type WritableResourceName = ResourceName | "contacts";

export const WRITABLE_RESOURCE_NAMES = ["contacts", ...RESOURCE_NAMES] as [WritableResourceName, ...WritableResourceName[]];

/** 作成時の data の例（必須項目は各エンティティのバリデーション定義に基づく） */
export const CREATE_EXAMPLES: Partial<Record<WritableResourceName, string>> = {
  contacts: '{"email":"a@example.com","firstname":"Alice","lastname":"Tanaka","company":"Acme","tags":["vip"],"owner":1}',
  companies: '{"companyname":"Acme Corp","companycity":"Tokyo","companywebsite":"https://acme.example.com"}',
  segments: '{"name":"Newsletter","alias":"newsletter","isPublished":true,"filters":[]}',
  tags: '{"tag":"vip"}  (only "tag" is writable)',
  notes: '{"lead":42,"text":"Called about renewal","type":"call"}  (type: general|email|call|meeting)',
  emails: '{"name":"September news","subject":"News for September","customHtml":"<p>Hello {contactfield=firstname}</p>","emailType":"list","lists":[3]}',
  categories: '{"title":"Newsletters","bundle":"email"}',
  contact_fields: '{"label":"Plan","alias":"plan","type":"select","properties":{"list":[{"label":"Free","value":"free"},{"label":"Pro","value":"pro"}]}}',
  stages: '{"name":"Customer","weight":50}',
  point_actions: '{"name":"Opened newsletter","type":"email.open","delta":5}  (types: mautic_list_lookup kind=point_action_types)',
  webhooks: '{"name":"CRM sync","webhookUrl":"https://example.com/hook","triggers":["mautic.lead_post_save_new"]}',
  campaigns:
    '{"name":"Onboarding","isPublished":false,"lists":[{"id":3}],"events":[{"id":"new_1","name":"Add 10 points","type":"lead.changepoints","eventType":"action","order":1,"properties":{"points":10},"triggerMode":"immediate"}]}  (at least one event is required; "lists" are source segment IDs)',
  pages: '{"title":"Landing","customHtml":"<h1>Hi</h1>","isPublished":false}',
};
