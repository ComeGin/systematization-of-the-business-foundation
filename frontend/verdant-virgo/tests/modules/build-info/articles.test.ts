import { describe, expect, it, vi } from "vitest";
import { fetchBuildArticles } from "@/modules/build-info/articles";

const ENV = { STRAPI_URL: "http://127.0.0.1:1338", STRAPI_API_TOKEN: "test-token" };

type Row = Record<string, unknown>;

const page = (data: Row[], pageNumber: number, pageCount: number) =>
  new Response(
    JSON.stringify({ data, meta: { pagination: { page: pageNumber, pageCount } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const row = (slug: string, extra: Row = {}): Row => ({
  slug,
  publishedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...extra,
});

describe("fetchBuildArticles", () => {
  describe("正常系", () => {
    it("入力: 2 ページに分かれた応答を 1 つの配列にし、slug の昇順で返す", async () => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        return url.searchParams.get("pagination[page]") === "2"
          ? page([row("alpha")], 2, 2)
          : page([row("charlie"), row("bravo")], 1, 2);
      });
      const result = await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch);
      expect(result?.map((a) => a.slug)).toEqual(["alpha", "bravo", "charlie"]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("入力: 公開済みだけ・必要な項目だけ・100 件ずつ・Bearer 付きで問い合わせる", async () => {
      const fetchImpl = vi.fn(async () => page([row("a")], 1, 1));
      await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch);
      const [input, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const url = new URL(input);
      expect(url.origin).toBe("http://127.0.0.1:1338");
      expect(url.pathname).toBe("/api/articles");
      expect(url.searchParams.get("status")).toBe("published");
      expect(url.searchParams.get("fields[0]")).toBe("slug");
      expect(url.searchParams.get("fields[1]")).toBe("publishedAt");
      expect(url.searchParams.get("fields[2]")).toBe("updatedAt");
      expect(url.searchParams.get("pagination[pageSize]")).toBe("100");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    });

    it("入力: documentId などほかのフィールドは結果に入らない", async () => {
      const fetchImpl = vi.fn(async () =>
        page([row("a", { documentId: "doc123", id: 7, title: "題" })], 1, 1),
      );
      const result = await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch);
      expect(result).toEqual([
        { slug: "a", publishedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" },
      ]);
      expect(JSON.stringify(result)).not.toContain("doc123");
    });

    it("空入力: 記事が 0 件なら空配列（null ではない）", async () => {
      const fetchImpl = vi.fn(async () => page([], 1, 0));
      expect(await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch)).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: Strapi が 500 を返すと null", async () => {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
      expect(await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch)).toBeNull();
    });

    it("入力: STRAPI_URL が無いと fetch を呼ばずに null", async () => {
      const fetchImpl = vi.fn();
      const result = await fetchBuildArticles(
        { STRAPI_API_TOKEN: "t" },
        fetchImpl as unknown as typeof fetch,
      );
      expect(result).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("入力: STRAPI_API_TOKEN が無いと fetch を呼ばずに null", async () => {
      const fetchImpl = vi.fn();
      const result = await fetchBuildArticles(
        { STRAPI_URL: "http://127.0.0.1:1338" },
        fetchImpl as unknown as typeof fetch,
      );
      expect(result).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("入力: 接続できない（fetch が例外）と null", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch)).toBeNull();
    });

    it("入力: 応答の形が想定と違うと null", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: "x" }), { status: 200 }));
      expect(await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch)).toBeNull();
    });

    it("入力: slug や日時が欠けた行があると null（一部だけの一覧を出さない）", async () => {
      const fetchImpl = vi.fn(async () => page([row("a"), { slug: "b" }], 1, 1));
      expect(await fetchBuildArticles(ENV, fetchImpl as unknown as typeof fetch)).toBeNull();
    });
  });
});
