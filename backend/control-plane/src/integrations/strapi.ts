// 本番の Strapi 5 の REST（Content API）。published-article-check（読み取り）と article-cover・campaign-asset-upload（書き込み）が使う。
// - 読み取りは readToken、書き込みは writeToken。writeToken が無いときの書き込みメソッドは IntegrationError（auth_failed）。
// - 下書きは `status=draft`、公開版は `status=published`（Strapi 5 の指定）。
// - 応答の形が想定と違えば invalid_response にする（黙って進めない）。トークンと応答の本文はログに出さない。
import { IntegrationError, fetchJson, requireSuccess } from "./http.js";

const READ_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface PublishedArticle {
  documentId: string;
  slug: string;
  publishedAt: string;
  updatedAt: string;
}

export interface DraftArticle {
  documentId: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  updatedAt: string;
  /** 公開版があり、その cover が空でない（下書きの cover だけが空）。article-cover は画像を作らず、公開版の cover を下書きに結ぶ */
  hasPublishedCover?: boolean;
}

/** 記事 1 本（cover と blocks を展開したもの）。blocks の中身は Strapi の動的ゾーンのまま持つ。 */
export interface StrapiArticle {
  documentId: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  updatedAt: string;
  cover: { id: number; url: string } | null;
  blocks: Record<string, unknown>[];
}

export interface UploadFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface UploadedFile {
  id: number;
  url: string;
}

interface ListResponse {
  data: Record<string, unknown>[];
  meta?: { pagination?: { page?: number; pageCount?: number } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(what: string): IntegrationError {
  return new IntegrationError("invalid_response", `Strapi の応答の形が想定と違う: ${what}`);
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** populate 済みのメディア（`{ id, url, ... }`）を取り出す。無い・形が違うなら null */
function mediaOf(value: unknown): { id: number; url: string } | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  return { id: value.id, url: typeof value.url === "string" ? value.url : "" };
}

/** 展開した記事の blocks を、PUT で書き戻せる形にする。component の id は捨て（作り直し）、メディアはファイルの id にする。 */
function blocksForWrite(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  const asId = (value: unknown): unknown => {
    const media = mediaOf(value);
    if (media && isRecord(value) && ("url" in value || "mime" in value)) return media.id;
    return value;
  };
  return blocks.map((block) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block)) {
      if (key === "id") continue;
      out[key] = Array.isArray(value) ? value.map(asId) : asId(value);
    }
    return out;
  });
}

// 記事 1 本を読むときの populate（cover と、動的ゾーンの中のメディア）
const ARTICLE_POPULATE = [
  "populate[cover]=true",
  "populate[blocks][on][shared.media][populate][file]=true",
  "populate[blocks][on][shared.quote]=true",
  "populate[blocks][on][shared.rich-text]=true",
  "populate[blocks][on][shared.slider][populate][files]=true",
].join("&");

export class StrapiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly readToken: string,
    private readonly writeToken: string | null,
  ) {}

  private url(pathAndQuery: string): string {
    return `${this.baseUrl}/api/${pathAndQuery}`;
  }

  private async get<T>(pathAndQuery: string, signal: AbortSignal, what: string): Promise<{ data: T | null; status: number | null }> {
    const result = await fetchJson<T>({
      upstream: "other",
      url: this.url(pathAndQuery),
      init: { headers: { Authorization: `Bearer ${this.readToken}` } },
      timeoutMs: READ_TIMEOUT_MS,
      signal,
    });
    // 404 は「無い」として呼び出し側で扱う（getArticle）。それ以外の失敗は例外
    if (result.status === 404) return { data: null, status: 404 };
    requireSuccess(result, what);
    return { data: result.data, status: result.status };
  }

  /** ページを最後まで読む（1 ページ 100 件。MAX_PAGES を超えたら invalid_response） */
  private async listAll(query: string, signal: AbortSignal, what: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await this.get<ListResponse>(
        `articles?${query}&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
        signal,
        what,
      );
      if (!data || !Array.isArray(data.data)) throw invalid(what);
      rows.push(...data.data.filter(isRecord));
      const pageCount = data.meta?.pagination?.pageCount;
      if (typeof pageCount !== "number") throw invalid(`${what}（pagination が無い）`);
      if (page >= pageCount) return rows;
    }
    throw invalid(`${what}（${MAX_PAGES} ページを超えた）`);
  }

  /** 公開中の記事の一覧（documentId・slug・publishedAt・updatedAt）。slug の昇順 */
  async listPublishedArticles(signal: AbortSignal): Promise<PublishedArticle[]> {
    const rows = await this.listAll(
      "status=published&fields[0]=documentId&fields[1]=slug&fields[2]=publishedAt&fields[3]=updatedAt&sort[0]=slug:asc",
      signal,
      "公開済みの記事の一覧",
    );
    return rows.map((row) => {
      const documentId = str(row, "documentId");
      const slug = str(row, "slug");
      const publishedAt = str(row, "publishedAt");
      const updatedAt = str(row, "updatedAt");
      if (!documentId || !slug || !publishedAt || !updatedAt) throw invalid("公開済みの記事の欠けた項目");
      return { documentId, slug, publishedAt, updatedAt };
    });
  }

  /** 記事 1 本。無ければ null。draft は下書き、published は公開版 */
  async getArticle(documentId: string, status: "draft" | "published", signal: AbortSignal): Promise<StrapiArticle | null> {
    const { data, status: http } = await this.get<{ data?: unknown }>(
      `articles/${encodeURIComponent(documentId)}?status=${status}&${ARTICLE_POPULATE}`,
      signal,
      "記事の取得",
    );
    if (http === 404 || !data) return null;
    const row = data.data;
    if (!isRecord(row)) throw invalid("記事 1 本");
    const id = str(row, "documentId");
    const updatedAt = str(row, "updatedAt");
    if (!id || !updatedAt) throw invalid("記事 1 本の欠けた項目");
    return {
      documentId: id,
      slug: str(row, "slug"),
      title: str(row, "title"),
      description: str(row, "description"),
      publishedAt: str(row, "publishedAt"),
      updatedAt,
      cover: mediaOf(row.cover),
      blocks: Array.isArray(row.blocks) ? row.blocks.filter(isRecord) : [],
    };
  }

  /** documentId の一覧（query に fields[0]=documentId を含める） */
  private async listDocumentIds(query: string, signal: AbortSignal, what: string): Promise<Set<string>> {
    const rows = await this.listAll(query, signal, what);
    const ids = new Set<string>();
    for (const row of rows) {
      const documentId = str(row, "documentId");
      if (!documentId) throw invalid(`${what}の欠けた項目`);
      ids.add(documentId);
    }
    return ids;
  }

  /**
   * アイキャッチの無い下書きの一覧（article-cover の対象）。更新の新しい順ではなく slug の昇順。
   * Strapi 5 では公開済みの記事にも下書きの版があるため、status=draft だけでは過去の記事すべてが対象になる（Ruling 33）。
   * 対象は、公開版がまだ無い記事（新しい記事）と、公開版がある記事のうち公開版の cover も空のものだけ。
   * 公開版に cover があり下書きの cover だけが空の記事は hasPublishedCover: true で返す（画像は作らず、公開版の cover を結ぶ。P8）
   */
  async listDraftArticlesWithoutCover(signal: AbortSignal): Promise<DraftArticle[]> {
    const rows = await this.listAll(
      "status=draft&filters[cover][id][$null]=true&fields[0]=documentId&fields[1]=slug&fields[2]=title&fields[3]=description&fields[4]=updatedAt&sort[0]=slug:asc",
      signal,
      "アイキャッチの無い下書きの一覧",
    );
    const published = await this.listDocumentIds("status=published&fields[0]=documentId&sort[0]=documentId:asc", signal, "公開済みの記事の ID の一覧");
    const publishedWithoutCover = await this.listDocumentIds(
      "status=published&filters[cover][id][$null]=true&fields[0]=documentId&sort[0]=documentId:asc",
      signal,
      "アイキャッチの無い公開済みの記事の ID の一覧",
    );
    return rows.map((row) => {
      const documentId = str(row, "documentId");
      const updatedAt = str(row, "updatedAt");
      if (!documentId || !updatedAt) throw invalid("下書きの欠けた項目");
      const hasPublishedCover = published.has(documentId) && !publishedWithoutCover.has(documentId);
      return { documentId, slug: str(row, "slug"), title: str(row, "title"), description: str(row, "description"), updatedAt, hasPublishedCover };
    });
  }

  // ---- 以下は書き込み。writeToken（CONTROL_STRAPI_WRITE_TOKEN）が要る。無ければ IntegrationError ----

  private writeHeaders(): Record<string, string> {
    if (!this.writeToken) {
      throw new IntegrationError("auth_failed", "Strapi への書き込みには CONTROL_STRAPI_WRITE_TOKEN が要る");
    }
    return { Authorization: `Bearer ${this.writeToken}` };
  }

  /** メディアライブラリへファイルを上げる（POST /api/upload。multipart のフィールド名は files）。writeToken が要る。 */
  async uploadFile(file: UploadFile, signal: AbortSignal): Promise<UploadedFile> {
    const headers = this.writeHeaders();
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name);
    const result = await fetchJson<unknown>({
      upstream: "other",
      url: this.url("upload"),
      init: { method: "POST", headers, body: form },
      timeoutMs: UPLOAD_TIMEOUT_MS,
      signal,
      // 二重にアップロードしないよう、再試行しない
      budgetMs: 0,
    });
    requireSuccess(result, "ファイルのアップロード");
    const first = Array.isArray(result.data) ? result.data[0] : null;
    const media = mediaOf(first);
    if (!media) throw invalid("アップロードの結果");
    return media;
  }

  private async putDraft(documentId: string, data: Record<string, unknown>, signal: AbortSignal, what: string): Promise<void> {
    const headers = { ...this.writeHeaders(), "Content-Type": "application/json" };
    const result = await fetchJson<unknown>({
      upstream: "other",
      url: this.url(`articles/${encodeURIComponent(documentId)}?status=draft`),
      init: { method: "PUT", headers, body: JSON.stringify({ data }) },
      timeoutMs: READ_TIMEOUT_MS,
      signal,
    });
    requireSuccess(result, what);
  }

  /** 下書きのアイキャッチを設定する。writeToken が要る。 */
  async setArticleCover(documentId: string, fileId: number, signal: AbortSignal): Promise<void> {
    await this.putDraft(documentId, { cover: fileId }, signal, "アイキャッチの設定");
  }

  /**
   * 下書きの blocks の末尾に shared.media（file）を足す。writeToken が要る。
   * 下書きを読み、既存の blocks を書き戻せる形にしてから、足した全体を PUT する（動的ゾーンは部分更新できない）。
   */
  async attachArticleFile(documentId: string, fileId: number, signal: AbortSignal): Promise<void> {
    this.writeHeaders();
    const draft = await this.getArticle(documentId, "draft", signal);
    if (!draft) throw new IntegrationError("invalid_response", "ファイルを添える下書きが見つからない");
    const blocks = [...blocksForWrite(draft.blocks), { __component: "shared.media", file: fileId }];
    await this.putDraft(documentId, { blocks }, signal, "配布ファイルの添付");
  }
}
