// 開発の n8n の公開 API（/api/v1。ヘッダー X-N8N-API-KEY）。キーは状態ファイルの N8N_API_KEY（setup の n8n モジュールが作る）。
// ワークフローの有効化はテストの間だけにし、元の状態に戻す（親の I-11・I-12 は開発では未公開が既定）。
import { requireValue } from "./env.ts";
import { http, type HttpResult } from "./http.ts";
import { DEV } from "./services.ts";

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
}

export async function n8nApi<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<HttpResult<T>> {
  return http<T>(`${DEV.n8n}/api/v1${path}`, { ...init, headers: { "X-N8N-API-KEY": requireValue("N8N_API_KEY"), accept: "application/json" } });
}

export async function listWorkflows(): Promise<N8nWorkflowSummary[]> {
  const out: N8nWorkflowSummary[] = [];
  let cursor: string | undefined;
  do {
    const res = await n8nApi<{ data: N8nWorkflowSummary[]; nextCursor?: string | null }>(`/workflows?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    if (res.status !== 200 || !res.json) throw new Error(`n8n のワークフロー一覧を取れない（HTTP ${res.status}）`);
    out.push(...res.json.data.map(({ id, name, active }) => ({ id, name, active })));
    cursor = res.json.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

/**
 * 名前が prefix で始まるワークフローを 1 つ選ぶ。同じ名前が複数ある（過去の取り込みの残り）ときは有効なもの、
 * 無ければ最後に見つかったものを返す。provision は名前で探して更新するので、通常は 1 つ。
 */
export async function findWorkflow(prefix: string): Promise<N8nWorkflowSummary> {
  const matches = (await listWorkflows()).filter((w) => w.name.startsWith(prefix));
  const found = matches.find((w) => w.active) ?? matches.at(-1);
  if (!found) throw new Error(`n8n にワークフロー「${prefix}…」が無い（setup の n8n モジュールで取り込む）`);
  return found;
}

export async function setActive(id: string, active: boolean): Promise<void> {
  const res = await n8nApi(`/workflows/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" });
  if (res.status !== 200) throw new Error(`n8n のワークフロー ${id} を ${active ? "有効" : "無効"} にできない（HTTP ${res.status}: ${res.text.slice(0, 200)}）`);
}

/** prefix のワークフローを有効にし、元に戻す関数を返す（もともと有効なら何もしない） */
export async function activateForTest(prefix: string): Promise<{ workflow: N8nWorkflowSummary; restore: () => Promise<void> }> {
  const workflow = await findWorkflow(prefix);
  if (workflow.active) return { workflow, restore: async () => {} };
  await setActive(workflow.id, true);
  return { workflow, restore: () => setActive(workflow.id, false) };
}

/** Data Table の id を名前で引く（provision の DATA_TABLES の名前） */
export async function dataTableId(name: string): Promise<string> {
  const res = await n8nApi<{ data: Array<{ id: string; name: string }> }>(`/data-tables?limit=100`);
  const found = res.json?.data.find((t) => t.name === name);
  if (!found) throw new Error(`n8n の Data Table「${name}」が無い（HTTP ${res.status}）`);
  return found.id;
}
