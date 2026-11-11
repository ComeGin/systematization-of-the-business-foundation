// build-info モジュール: ビルドに含めた「公開済みの記事」の一覧を Strapi から取る。
// 目的は dist/build-info.json の articles に残すこと。監視アプリ（control-plane）が、Strapi で公開された記事のうち
// 配信中のサイトにまだ入っていないもの（再配信が要る状態）を見つけるのに使う
// （docs/superpowers/specs/2026-11-11-deploy-drift-detection-design.md）。
// 公開される JSON に入るので、slug・publishedAt・updatedAt だけを返す（documentId・id・トークンは入れない）。
// ブログのビルド（blog/lib/strapi.ts）と違い、取れなかったときはビルドを止めず null を返す。
// 一覧が取れないことで、記事の本体の読み込み（こちらは失敗でビルドを止める）の判定を変えないため。

export interface BuildArticle {
  readonly slug: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
}

const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
// ページ数の暴走（応答の不具合）でビルドが終わらなくならないための上限。100 件 × 1,000 ページ
const MAX_PAGES = 1_000;

interface ListResponse {
  data: unknown;
  meta?: { pagination?: { pageCount?: unknown } };
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** 1 行を BuildArticle に絞る。必要な項目が欠けていたら null */
function toBuildArticle(row: unknown): BuildArticle | null {
  if (typeof row !== "object" || row === null) return null;
  const { slug, publishedAt, updatedAt } = row as Record<string, unknown>;
  if (!isNonEmptyString(slug) || !isNonEmptyString(publishedAt) || !isNonEmptyString(updatedAt)) {
    return null;
  }
  return { slug, publishedAt, updatedAt };
}

/**
 * 公開済みの記事を slug の昇順で返す。Strapi に届かない・応答が想定と違う・項目が欠けるなど、
 * 一覧を完全には取れなかったときは null（一部だけの一覧は返さない）。例外は投げない。
 */
export async function fetchBuildArticles(
  env: { STRAPI_URL?: string; STRAPI_API_TOKEN?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<BuildArticle[] | null> {
  const baseUrl = env.STRAPI_URL?.trim();
  const token = env.STRAPI_API_TOKEN?.trim();
  if (!baseUrl || !token) return null;

  try {
    const origin = new URL(baseUrl).origin;
    const articles: BuildArticle[] = [];
    let pageCount = 1;
    for (let page = 1; page <= pageCount; page++) {
      if (page > MAX_PAGES) return null;
      const query = [
        "status=published",
        "fields[0]=slug",
        "fields[1]=publishedAt",
        "fields[2]=updatedAt",
        "sort[0]=slug:asc",
        `pagination[page]=${page}`,
        `pagination[pageSize]=${PAGE_SIZE}`,
      ].join("&");
      const response = await fetchImpl(`${origin}/api/articles?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as ListResponse;
      const count = body.meta?.pagination?.pageCount;
      if (!Array.isArray(body.data) || typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        return null;
      }
      pageCount = count;
      for (const row of body.data) {
        const article = toBuildArticle(row);
        if (article === null) return null;
        articles.push(article);
      }
    }
    // ロケールに依存しない順序（コード単位）。同じ入力から必ず同じ JSON になる
    return articles.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  } catch {
    return null;
  }
}
