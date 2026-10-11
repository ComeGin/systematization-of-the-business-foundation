// 開発の MailHog（127.0.0.1:8025。Mautic のコンテナ）の API。n8n の I-21 は開発では SNS ではなくここへ送る。
// 他の操作が送ったメールと混ざるので、件名や本文に含まれる RUN_ID で絞って探す。
import { http } from "./http.ts";
import { DEV } from "./services.ts";

export interface MailhogMessage {
  ID: string;
  Content: { Headers: Record<string, string[]>; Body: string };
  Raw: { From: string; To: string[] };
}

/** kind は MailHog の検索の種類（from・to・containing） */
export async function searchMail(kind: "from" | "to" | "containing", query: string): Promise<MailhogMessage[]> {
  const res = await http<{ items: MailhogMessage[] }>(`${DEV.mailhog}/api/v2/search?kind=${kind}&query=${encodeURIComponent(query)}&limit=50`);
  if (res.status !== 200) throw new Error(`MailHog の検索に失敗（HTTP ${res.status}）`);
  return res.json?.items ?? [];
}

export const subjectOf = (m: MailhogMessage): string => m.Content.Headers.Subject?.[0] ?? "";

export async function deleteMail(id: string): Promise<void> {
  await http(`${DEV.mailhog}/api/v1/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
}
