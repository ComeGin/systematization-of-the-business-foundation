import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../../src/integrations/http.js";
import { N8nClient } from "../../src/integrations/n8n.js";

// 本番の n8n の Public API は global fetch のモックで差し替える（実 n8n・127.0.0.1 の開発の n8n には繋がない）
const config = { baseUrl: "https://n8n.example.test", apiKey: "n8n_api_key_SECRET_value" };

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const urls = () => fetchMock.mock.calls.map((call) => call[0] as string);

/** id と name を持つ一覧の要素。 */
const row = (id: string, name = `wf ${id}`, extra: Record<string, unknown> = {}) => ({ id, name, ...extra });

/** 失敗の例外を取り出す（投げなければテストを落とす）。 */
async function errorOf(promise: Promise<unknown>): Promise<IntegrationError> {
  const error = await promise.then(
    () => {
      throw new Error("例外にならなかった");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IntegrationError);
  return error as IntegrationError;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.useRealTimers());

describe("N8nClient.listWorkflows", () => {
  describe("正常系", () => {
    it("X-N8N-API-KEY を付けて /api/v1/workflows を GET し、ピン留めデータを除いて 250 件ずつ読む（タイムアウト 30 秒）", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockResolvedValueOnce(json({ data: [row("a")], nextCursor: null }));
      await new N8nClient(config).listWorkflows();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://n8n.example.test/api/v1/workflows?limit=250&excludePinnedData=true");
      expect(init.method).toBe("GET");
      expect(init.headers).toEqual({ "X-N8N-API-KEY": "n8n_api_key_SECRET_value", Accept: "application/json" });
      expect(timeout).toHaveBeenCalledWith(30_000);
    });

    it("id・name・isArchived だけを返し、isArchived は true のときだけ true", async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          data: [
            row("a", "I-01 問い合わせ", { isArchived: true, nodes: [{ parameters: { token: "x" } }] }),
            row("b", "B", { isArchived: false }),
            row("c", "C", { isArchived: "true" }),
            row("d", "D"),
          ],
        }),
      );
      expect(await new N8nClient(config).listWorkflows()).toEqual([
        { id: "a", name: "I-01 問い合わせ", isArchived: true },
        { id: "b", name: "B", isArchived: false },
        { id: "c", name: "C", isArchived: false },
        { id: "d", name: "D", isArchived: false },
      ]);
    });

    it("nextCursor をたどって全ページを読み、cursor は URL 符号化する", async () => {
      fetchMock
        .mockResolvedValueOnce(json({ data: [row("a")], nextCursor: "c/1+=" }))
        .mockResolvedValueOnce(json({ data: [row("b")], nextCursor: "c2" }))
        .mockResolvedValueOnce(json({ data: [row("c")] }));
      const all = await new N8nClient(config).listWorkflows();
      expect(all.map((workflow) => workflow.id)).toEqual(["a", "b", "c"]);
      expect(urls()).toEqual([
        "https://n8n.example.test/api/v1/workflows?limit=250&excludePinnedData=true",
        "https://n8n.example.test/api/v1/workflows?limit=250&excludePinnedData=true&cursor=c%2F1%2B%3D",
        "https://n8n.example.test/api/v1/workflows?limit=250&excludePinnedData=true&cursor=c2",
      ]);
    });

    it("20 ページちょうどで終われば打ち切りにしない", async () => {
      for (let page = 0; page < 19; page++) fetchMock.mockResolvedValueOnce(json({ data: [row(`w${page}`)], nextCursor: `p${page + 1}` }));
      fetchMock.mockResolvedValueOnce(json({ data: [row("w19")], nextCursor: null }));
      expect(await new N8nClient(config).listWorkflows()).toHaveLength(20);
      expect(fetchMock).toHaveBeenCalledTimes(20);
    });

    it("空入力: ワークフローが 0 件なら空配列", async () => {
      fetchMock.mockResolvedValueOnce(json({ data: [], nextCursor: null }));
      expect(await new N8nClient(config).listWorkflows()).toEqual([]);
    });

    it("空入力: nextCursor が空文字なら最後のページとして扱う", async () => {
      fetchMock.mockResolvedValueOnce(json({ data: [row("a")], nextCursor: "" }));
      expect(await new N8nClient(config).listWorkflows()).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("異常系", () => {
    it("サーバ: 21 ページ目があれば truncated で止め、途中までの一覧を返さない", async () => {
      fetchMock.mockImplementation(async () => json({ data: [row("x")], nextCursor: "more" }));
      const error = await errorOf(new N8nClient(config).listWorkflows());
      expect(error.failureClass).toBe("truncated");
      expect(error.message).toContain("20 ページ");
      expect(fetchMock).toHaveBeenCalledTimes(20);
    });

    it.each([
      [401, "auth_failed"],
      [403, "permission_denied"],
      [404, "invalid_response"],
      [500, "invalid_response"],
      [503, "invalid_response"],
    ] as const)("サーバ: HTTP %s は %s の IntegrationError で、再試行しない", async (status, failureClass) => {
      fetchMock.mockImplementation(async () => json({ message: "unauthorized" }, status));
      const error = await errorOf(new N8nClient(config).listWorkflows());
      expect(error.failureClass).toBe(failureClass);
      expect(error.message).toBe(`n8n: ワークフローの一覧: ${failureClass} (HTTP ${status})`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 429 で Retry-After が予算を超えるなら待たずに rate_limited", async () => {
      fetchMock.mockImplementation(async () => json({}, 429, { "retry-after": "120" }));
      expect((await errorOf(new N8nClient(config).listWorkflows())).failureClass).toBe("rate_limited");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 接続できなければ 3 秒・9 秒待って再試行し、それでも駄目なら unreachable", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });
      const pending = errorOf(new N8nClient(config).listWorkflows());
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await pending).failureClass).toBe("unreachable");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("サーバ: 応答が返らずタイムアウトしたら timeout（1 回だけ再試行）", async () => {
      vi.useFakeTimers();
      const controllers: AbortController[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
      });
      fetchMock.mockImplementation(async () => {
        controllers.at(-1)!.abort();
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
      const pending = errorOf(new N8nClient(config).listWorkflows());
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await pending).failureClass).toBe("timeout");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("サーバ: JSON でない応答（メンテナンスの HTML など）は invalid_response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("<html>502 Bad Gateway</html>", { status: 200 }));
      expect((await errorOf(new N8nClient(config).listWorkflows())).failureClass).toBe("invalid_response");
    });

    it.each([
      ["data が無い", { workflows: [] }],
      ["data が配列でない", { data: { id: "a" } }],
      ["配列そのもの", [row("a")]],
    ])("サーバ: 想定外の形の応答（%s）は invalid_response", async (_label, body) => {
      fetchMock.mockResolvedValueOnce(json(body));
      const error = await errorOf(new N8nClient(config).listWorkflows());
      expect(error).toMatchObject({ failureClass: "invalid_response", message: "n8n: 一覧の形が想定と違う" });
    });

    it.each([
      ["id が無い", { name: "a" }],
      ["id が数値", { id: 1, name: "a" }],
      ["name が無い", { id: "a" }],
      ["要素が文字列", "a"],
      ["要素が null", null],
    ])("サーバ: 一覧の要素の %s なら invalid_response", async (_label, item) => {
      fetchMock.mockResolvedValueOnce(json({ data: [row("ok"), item] }));
      const error = await errorOf(new N8nClient(config).listWorkflows());
      expect(error).toMatchObject({ failureClass: "invalid_response", message: "n8n: 一覧の要素に id または name が無い" });
    });

    it("空入力: 本文の無い 2xx（204）は形が想定と違うものとして invalid_response", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect((await errorOf(new N8nClient(config).listWorkflows())).failureClass).toBe("invalid_response");
    });

    it("サーバ: 2 ページ目の失敗は、それまでの一覧を返さずに例外にする", async () => {
      fetchMock.mockResolvedValueOnce(json({ data: [row("a")], nextCursor: "c2" })).mockResolvedValueOnce(json({}, 500));
      expect((await errorOf(new N8nClient(config).listWorkflows())).failureClass).toBe("invalid_response");
    });

    it("入力: 外から打ち切られていれば timeout で、再試行しない", async () => {
      const stop = new AbortController();
      stop.abort();
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return json({ data: [] });
      });
      expect((await errorOf(new N8nClient(config, stop.signal).listWorkflows())).failureClass).toBe("timeout");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("サーバ: エラーの文言に API キーも応答の本文も含めない", async () => {
      fetchMock.mockImplementation(async () => json({ message: "taro@example.com の API キー n8n_api_key_SECRET_value" }, 401));
      const error = await errorOf(new N8nClient(config).listWorkflows());
      expect(error.message).not.toContain("n8n_api_key_SECRET_value");
      expect(error.message).not.toContain("taro@example.com");
    });
  });
});

describe("N8nClient.getWorkflow", () => {
  describe("正常系", () => {
    it("id を URL 符号化して本体を取り、ピン留めデータは取らない", async () => {
      const body = { id: "a/b c", name: "I-01", nodes: [], connections: {} };
      fetchMock.mockResolvedValueOnce(json(body));
      expect(await new N8nClient(config).getWorkflow("a/b c")).toEqual(body);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://n8n.example.test/api/v1/workflows/a%2Fb%20c?excludePinnedData=true");
      expect(init.headers).toMatchObject({ "X-N8N-API-KEY": "n8n_api_key_SECRET_value" });
    });

    it("空入力: 空のオブジェクトの応答もそのまま返す（形の検査は正規化側）", async () => {
      fetchMock.mockResolvedValueOnce(json({}));
      expect(await new N8nClient(config).getWorkflow("a")).toEqual({});
    });
  });

  describe("異常系", () => {
    it("空入力: id が空文字でも例外にせず /workflows/ を読み、上流の 404 を invalid_response にする", async () => {
      fetchMock.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
      expect((await errorOf(new N8nClient(config).getWorkflow(""))).failureClass).toBe("invalid_response");
      expect(urls()).toEqual(["https://n8n.example.test/api/v1/workflows/?excludePinnedData=true"]);
    });

    it.each([
      ["配列", [{ id: "a" }]],
      ["文字列", "workflow"],
      ["数値", 1],
    ])("サーバ: 本体が%sなら invalid_response", async (_label, body) => {
      fetchMock.mockResolvedValueOnce(json(body));
      const error = await errorOf(new N8nClient(config).getWorkflow("a"));
      expect(error).toMatchObject({ failureClass: "invalid_response", message: "n8n: ワークフローの形が想定と違う" });
    });

    it("空入力: 本文の無い 2xx は invalid_response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      expect((await errorOf(new N8nClient(config).getWorkflow("a"))).failureClass).toBe("invalid_response");
    });

    it.each([
      [401, "auth_failed"],
      [403, "permission_denied"],
      [404, "invalid_response"],
      [500, "invalid_response"],
    ] as const)("サーバ: HTTP %s は %s の IntegrationError", async (status, failureClass) => {
      fetchMock.mockImplementation(async () => json({}, status));
      const error = await errorOf(new N8nClient(config).getWorkflow("a"));
      expect(error.failureClass).toBe(failureClass);
      expect(error.message).toBe(`n8n: ワークフローの取得: ${failureClass} (HTTP ${status})`);
      expect(error.message).not.toContain(config.apiKey);
    });
  });
});
