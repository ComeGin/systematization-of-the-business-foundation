/**
 * 開発用: 動作確認・評価用の架空コンタクトを Mautic に投入する（全件に mcp-test タグを付与）
 *
 *   pnpm seed:test           # 投入（mcp-test タグのコンタクトが既にあれば中断）
 *   pnpm seed:test --delete  # mcp-test タグのコンタクトを削除
 *
 * 環境変数は MCP サーバと同じ（MAUTIC_BASE_URL / MAUTIC_CLIENT_ID / MAUTIC_CLIENT_SECRET）。
 */

const TEST_TAG = "mcp-test";
const OWNER_USER_ID = 1;

type SeedContact = {
  firstname: string;
  lastname: string;
  email: string;
  company?: string;
  city?: string;
  country?: string;
  points: number;
  tags: string[];
  lastActive?: string;
  owner?: number;
  dnc?: { reason: 1 | 2 | 3; comments: string };
};

const CONTACTS: SeedContact[] = [
  { firstname: "Alice", lastname: "Tanaka", email: "alice.tanaka@acme.example.com", company: "Acme Corp", city: "Tokyo", country: "Japan", points: 120, tags: ["vip", "newsletter"], lastActive: "2026-09-10 09:00:00", owner: OWNER_USER_ID },
  { firstname: "Bob", lastname: "Suzuki", email: "bob.suzuki@acme.example.com", company: "Acme Corp", city: "Osaka", country: "Japan", points: 45, tags: ["newsletter"], lastActive: "2026-08-21 14:30:00" },
  { firstname: "Carol", lastname: "Sato", email: "carol.sato@acme.example.com", company: "Acme Corp", city: "Tokyo", country: "Japan", points: 8, tags: ["trial"], lastActive: "2026-07-02 11:15:00", dnc: { reason: 1, comments: "Unsubscribed from newsletter" } },
  { firstname: "David", lastname: "Kim", email: "david.kim@globex.example.com", company: "Globex", city: "Seoul", country: "South Korea", points: 210, tags: ["vip"], lastActive: "2026-09-12 18:45:00", owner: OWNER_USER_ID },
  { firstname: "Emma", lastname: "Watanabe", email: "emma.watanabe@globex.example.com", company: "Globex", city: "Fukuoka", country: "Japan", points: 67, tags: ["trial", "webinar-2026-08"], lastActive: "2026-08-30 10:00:00" },
  { firstname: "Frank", lastname: "Müller", email: "frank.mueller@initech.example.com", company: "Initech", city: "Berlin", country: "Germany", points: 33, tags: ["newsletter", "webinar-2026-08"], lastActive: "2026-06-15 08:20:00" },
  { firstname: "Grace", lastname: "Ito", email: "grace.ito@initech.example.com", company: "Initech", city: "Nagoya", country: "Japan", points: 150, tags: ["vip", "trial"], lastActive: "2026-09-05 16:10:00", owner: OWNER_USER_ID },
  { firstname: "Hiro", lastname: "Yamamoto", email: "hiro.yamamoto@umbrella.example.com", company: "Umbrella", city: "Sapporo", country: "Japan", points: 0, tags: [], dnc: { reason: 2, comments: "Hard bounce" } },
  { firstname: "Isabel", lastname: "García", email: "isabel.garcia@example.org", city: "Madrid", country: "Spain", points: 92, tags: ["newsletter"], lastActive: "2026-09-01 12:00:00" },
  { firstname: "Jun", lastname: "Kobayashi", email: "jun.kobayashi@example.org", city: "Tokyo", country: "Japan", points: 15, tags: ["webinar-2026-08"], lastActive: "2026-08-18 19:30:00" },
  { firstname: "Kate", lastname: "Brown", email: "kate.brown@globex.example.com", company: "Globex", city: "London", country: "United Kingdom", points: 78, tags: ["newsletter", "trial"], lastActive: "2026-07-25 07:45:00" },
  { firstname: "Leo", lastname: "Nakamura", email: "leo.nakamura@acme.example.com", company: "Acme Corp", city: "Yokohama", country: "Japan", points: 5, tags: ["trial"], dnc: { reason: 3, comments: "Requested no contact by phone call" } },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[ERROR] 環境変数 ${name} が未設定です`);
    process.exit(1);
  }
  return value;
}

const BASE_URL = requireEnv("MAUTIC_BASE_URL").replace(/\/+$/, "");

async function getToken(): Promise<string> {
  const response = await fetch(`${BASE_URL}/oauth/v2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: requireEnv("MAUTIC_CLIENT_ID"),
      client_secret: requireEnv("MAUTIC_CLIENT_SECRET"),
    }),
  });
  if (!response.ok) throw new Error(`トークン取得に失敗しました (${response.status}): ${await response.text()}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} /api${path} が失敗しました (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

async function findTestContactIds(token: string): Promise<number[]> {
  const query = new URLSearchParams({ search: `tag:${TEST_TAG}`, limit: "200", minimal: "1" });
  const data = await api<{ contacts: Record<string, { id: number }> | [] }>(token, "GET", `/contacts?${query}`);
  return Object.values(data.contacts).map((contact) => contact.id);
}

async function seed(token: string): Promise<void> {
  const existing = await findTestContactIds(token);
  if (existing.length > 0) {
    console.error(`[ERROR] ${TEST_TAG} タグのコンタクトが既に ${existing.length} 件あります。作り直す場合は --delete で削除してから実行してください`);
    process.exit(1);
  }

  const payload = CONTACTS.map(({ dnc: _dnc, tags, ...fields }) => ({ ...fields, tags: [TEST_TAG, ...tags] }));
  const created = await api<{ contacts: { id: number; fields: { all: { email: string } } }[] }>(token, "POST", "/contacts/batch/new", payload);

  const idByEmail = new Map(created.contacts.map((contact) => [contact.fields.all.email, contact.id]));
  for (const contact of CONTACTS) {
    const id = idByEmail.get(contact.email);
    if (!id) throw new Error(`作成結果に ${contact.email} が見つかりません`);
    if (contact.dnc) await api(token, "POST", `/contacts/${id}/dnc/email/add`, contact.dnc);
    console.log(`  created id=${id} ${contact.email}${contact.dnc ? " (DNC)" : ""}`);
  }
  console.log(`${created.contacts.length} 件のテストコンタクトを作成しました`);
}

async function remove(token: string): Promise<void> {
  const ids = await findTestContactIds(token);
  if (ids.length === 0) {
    console.log(`${TEST_TAG} タグのコンタクトはありません`);
    return;
  }
  await api(token, "DELETE", `/contacts/batch/delete?${new URLSearchParams({ ids: ids.join(",") })}`);
  console.log(`${ids.length} 件のテストコンタクトを削除しました: ${ids.join(", ")}`);
}

const token = await getToken();
await (process.argv.includes("--delete") ? remove(token) : seed(token));
