// 開発の Mautic の REST API（OAuth2 client_credentials）。資格情報は dev.conf の MAUTIC_CLIENT_ID・MAUTIC_CLIENT_SECRET
// （画面で作る。setup/README.md の「画面での操作」）。トークンはファイルの中でだけ使い回す。
import { requireValue } from "./env.ts";
import { http, type HttpResult } from "./http.ts";
import { DEV } from "./services.ts";

let token: { value: string; expiresAt: number } | undefined;

export async function mauticToken(): Promise<string> {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: requireValue("MAUTIC_CLIENT_ID"), client_secret: requireValue("MAUTIC_CLIENT_SECRET") });
  const res = await http<{ access_token: string; expires_in: number }>(`${DEV.mautic}/oauth/v2/token`, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  if (res.status !== 200 || !res.json?.access_token) throw new Error(`Mautic のトークンを取れない（HTTP ${res.status}）`);
  token = { value: res.json.access_token, expiresAt: Date.now() + res.json.expires_in * 1000 };
  return token.value;
}

export async function mauticApi<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResult<T>> {
  return http<T>(`${DEV.mautic}/api${path}`, { ...init, headers: { authorization: `Bearer ${await mauticToken()}`, accept: "application/json" } });
}

/** メールアドレスの完全一致でコンタクトを探す（無ければ空） */
export async function findContactsByEmail(email: string): Promise<Array<{ id: number; email: string }>> {
  const res = await mauticApi<{ contacts?: Record<string, { id: number; fields: { all: { email?: string } } }> }>(
    `/contacts?search=${encodeURIComponent(`email:${email}`)}&limit=10`,
  );
  if (res.status !== 200) throw new Error(`Mautic のコンタクト検索に失敗（HTTP ${res.status}）`);
  return Object.values(res.json?.contacts ?? {})
    .map((c) => ({ id: Number(c.id), email: String(c.fields.all.email ?? "") }))
    .filter((c) => c.email.toLowerCase() === email.toLowerCase());
}

export async function deleteContact(id: number): Promise<void> {
  const res = await mauticApi(`/contacts/${id}/delete`, { method: "DELETE" });
  if (res.status !== 200 && res.status !== 404) throw new Error(`Mautic のコンタクト ${id} を消せない（HTTP ${res.status}）`);
}
