// 本番の n8n の Public API（読み取りだけ。builtin n8n-export が使う）。
// 出典: https://docs.n8n.io/connect/n8n-api/pagination （limit 最大 250・cursor・nextCursor）、
//       https://docs.n8n.io/connect/n8n-api/authentication （X-N8N-API-KEY。一覧は workflow:list、単体の取得は workflow:read）
// API キーは監視アプリのサーバー側だけに置き、エージェントの実行環境には渡さない。応答の本文はログにも結果にも残さない。
import type { ControlPlaneConfig } from "../config.js";
import { CONTROL_TIMEOUT_SEC } from "../constants/timeouts.js";
import { type FetchJsonResult, IntegrationError, fetchJson, requireSuccess } from "./http.js";

type N8nExportConfig = NonNullable<ControlPlaneConfig["n8nExport"]>;

const PAGE_SIZE = 250;
/** 無限ループの歯止め。250 件 × 20 ページ。超えたら truncated として止める（途中までの一覧で書き出さない） */
const MAX_PAGES = 20;

export interface WorkflowSummary {
  id: string;
  name: string;
  isArchived: boolean;
}

export class N8nClient {
  constructor(
    private readonly config: N8nExportConfig,
    private readonly signal?: AbortSignal,
  ) {}

  private get<T>(path: string): Promise<FetchJsonResult<T>> {
    return fetchJson<T>({
      upstream: "other",
      url: `${this.config.baseUrl}/api/v1${path}`,
      init: { method: "GET", headers: { "X-N8N-API-KEY": this.config.apiKey, Accept: "application/json" } },
      timeoutMs: CONTROL_TIMEOUT_SEC.n8nApi * 1000,
      signal: this.signal,
    });
  }

  /** すべてのワークフローの id・名前・アーカイブ済みか。cursor で全ページをたどる。 */
  async listWorkflows(): Promise<WorkflowSummary[]> {
    const all: WorkflowSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: string = `limit=${PAGE_SIZE}&excludePinnedData=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const result: FetchJsonResult<{ data?: unknown[]; nextCursor?: string | null }> = await this.get(`/workflows?${query}`);
      requireSuccess(result, "n8n: ワークフローの一覧");
      if (!Array.isArray(result.data?.data)) throw new IntegrationError("invalid_response", "n8n: 一覧の形が想定と違う");
      for (const item of result.data.data) {
        const row = item as { id?: unknown; name?: unknown; isArchived?: unknown };
        if (typeof row.id !== "string" || typeof row.name !== "string") {
          throw new IntegrationError("invalid_response", "n8n: 一覧の要素に id または name が無い");
        }
        all.push({ id: row.id, name: row.name, isArchived: row.isArchived === true });
      }
      cursor = result.data.nextCursor ?? null;
      if (!cursor) return all;
    }
    throw new IntegrationError("truncated", `n8n: ワークフローの一覧が ${MAX_PAGES} ページを超えた`);
  }

  /** ワークフロー 1 件の本体（ピン留めデータは取らない）。 */
  async getWorkflow(id: string): Promise<unknown> {
    const result = await this.get<unknown>(`/workflows/${encodeURIComponent(id)}?excludePinnedData=true`);
    requireSuccess(result, "n8n: ワークフローの取得");
    if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
      throw new IntegrationError("invalid_response", "n8n: ワークフローの形が想定と違う");
    }
    return result.data;
  }
}
