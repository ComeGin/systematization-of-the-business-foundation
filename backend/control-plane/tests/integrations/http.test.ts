import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchJsonOptions, IntegrationError, fetchJson, requireSuccess } from "../../src/integrations/http.js";

// 上流の HTTP は global fetch のモックで差し替える（実ネットワーク・127.0.0.1 の開発のサービスには繋がない）
let timeouts: { ms: number; controller: AbortController }[];
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });

/** こちらのタイムアウトで切られた fetch（AbortSignal.timeout が発火した状態を作る）。 */
const timeoutFailure = async () => {
  timeouts.at(-1)!.controller.abort();
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
const connectFailure = async () => {
  throw new TypeError("fetch failed");
};

const options = (overrides: Partial<FetchJsonOptions> = {}): FetchJsonOptions => ({
  upstream: "other",
  url: "https://example.test/api",
  timeoutMs: 12_000,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  timeouts = [];
  // AbortSignal.timeout は実時間で動くため、テストから発火を決められるものに差し替える
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    timeouts.push({ ms, controller });
    return controller.signal;
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchJson の成功", () => {
  describe("正常系", () => {
    it("2xx の JSON は ok で data を返す（1 回だけ呼ぶ）", async () => {
      fetchMock.mockResolvedValueOnce(json({ a: 1 }));
      expect(await fetchJson(options())).toEqual({ failureClass: "ok", attempts: 1, status: 200, data: { a: 1 } });
      expect(timeouts[0]!.ms).toBe(12_000);
    });

    it("init の method・headers・body をそのまま fetch に渡し、打ち切りの signal を足す", async () => {
      fetchMock.mockResolvedValueOnce(json({}));
      await fetchJson(options({ init: { method: "POST", headers: { "X-Key": "k" }, body: "{}" } }));
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.test/api");
      expect(init).toMatchObject({ method: "POST", headers: { "X-Key": "k" }, body: "{}" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("空入力: 0 件の応答（countOf が 0）は empty_but_ok で、data は返す", async () => {
      fetchMock.mockResolvedValueOnce(json({ payload: [] }));
      const result = await fetchJson(options({ countOf: (data) => (data as { payload: unknown[] }).payload.length }));
      expect(result).toMatchObject({ failureClass: "empty_but_ok", data: { payload: [] } });
    });

    it("空入力: 本文が空の 2xx は ok で data は null", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "ok", status: 204, data: null });
    });

    it("空入力: 本文が空白だけの 2xx も JSON として読まず、ok で data は null", async () => {
      fetchMock.mockResolvedValueOnce(text("  \n"));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "ok", data: null });
    });

    it("空入力: init を省いても呼べる（fetch の既定の GET）", async () => {
      fetchMock.mockResolvedValueOnce(json({ a: 1 }));
      expect((await fetchJson(options({ init: undefined }))).failureClass).toBe("ok");
      expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBeUndefined();
    });
  });
});

describe("fetchJson の再試行しない分類", () => {
  describe("異常系", () => {
    it.each([
      ["github", 401, "auth_failed"],
      ["chatwoot", 401, "permission_denied"],
      ["other", 403, "permission_denied"],
      ["other", 404, "invalid_response"],
      ["other", 409, "invalid_response"],
      ["other", 422, "invalid_response"],
      ["other", 500, "invalid_response"],
    ] as const)("サーバ: %s の HTTP %s は %s で、再試行せず本文（個人情報を含みうる）を返さない", async (upstream, status, failureClass) => {
      fetchMock.mockImplementation(async () => json({ message: "taro@example.com" }, status));
      const result = await fetchJson(options({ upstream }));
      expect(result).toEqual({ failureClass, attempts: 1, status, data: null });
    });

    it("サーバ: JSON として読めない 2xx は invalid_response で、再試行しない", async () => {
      fetchMock.mockImplementation(async () => text("<html>maintenance</html>"));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "invalid_response", attempts: 1, data: null });
    });

    it("サーバ: 本文の読み取りの途中で切れたら unreachable として扱う", async () => {
      fetchMock.mockImplementation(async () => ({
        status: 200,
        headers: new Headers(),
        text: async () => {
          throw new TypeError("terminated");
        },
      }));
      const pending = fetchJson(options());
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await pending).toMatchObject({ failureClass: "unreachable", status: null, data: null });
    });

    it("サーバ: truncated は呼び出し側が条件を狭める（同じ条件で取り直さない）", async () => {
      fetchMock.mockImplementation(async () => json({ truncation_message: "..." }));
      const result = await fetchJson(options({ isTruncated: (data) => "truncation_message" in (data as object) }));
      expect(result).toMatchObject({ failureClass: "truncated", attempts: 1, data: null });
    });
  });
});

describe("fetchJson の auth_failed", () => {
  describe("正常系", () => {
    it("Mautic でも取り直した後に通れば ok", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ ok: true }));
      const result = await fetchJson(options({ upstream: "mautic", refreshAuth: async () => undefined }));
      expect(result).toMatchObject({ failureClass: "ok", attempts: 2 });
    });
  });

  describe("異常系", () => {
    it("サーバ: Mautic は refreshAuth でトークンを取り直して 1 回だけ再試行する", async () => {
      fetchMock.mockImplementation(async () => json({}, 401));
      const refreshAuth = vi.fn(async () => undefined);
      const result = await fetchJson(options({ upstream: "mautic", refreshAuth }));
      expect(refreshAuth).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ failureClass: "auth_failed", attempts: 2 });
    });

    it("サーバ: refreshAuth が無い・Mautic 以外は再試行しない", async () => {
      fetchMock.mockImplementation(async () => json({}, 401));
      expect((await fetchJson(options({ upstream: "mautic" }))).attempts).toBe(1);
      const refreshAuth = vi.fn(async () => undefined);
      expect((await fetchJson(options({ upstream: "github", refreshAuth }))).attempts).toBe(1);
      expect(refreshAuth).not.toHaveBeenCalled();
    });

    it("サーバ: トークンの取り直し自体が失敗したら、その例外をそのまま投げる", async () => {
      fetchMock.mockImplementation(async () => json({}, 401));
      const refreshAuth = async () => {
        throw new Error("token endpoint down");
      };
      await expect(fetchJson(options({ upstream: "mautic", refreshAuth }))).rejects.toThrow("token endpoint down");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("fetchJson の unreachable・timeout", () => {
  describe("正常系", () => {
    it("再試行で通れば ok", async () => {
      fetchMock.mockImplementationOnce(connectFailure).mockResolvedValueOnce(json({ a: 1 }));
      const pending = fetchJson(options());
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toMatchObject({ failureClass: "ok", attempts: 2, data: { a: 1 } });
    });
  });

  describe("異常系", () => {
    it("サーバ: 接続できなければ 3 秒・9 秒待って 2 回再試行する", async () => {
      fetchMock.mockImplementation(connectFailure);
      const pending = fetchJson(options());
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await pending).toMatchObject({ failureClass: "unreachable", attempts: 3, status: null, data: null });
    });

    it("サーバ: こちらのタイムアウトで切ったら timeout で、3 秒待って 1 回だけ再試行する", async () => {
      fetchMock.mockImplementation(timeoutFailure);
      const pending = fetchJson(options());
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ failureClass: "timeout", attempts: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("サーバ: 総予算に収まらない待ちはしない（予算 5 秒なら unreachable の 2 回目の 9 秒は待たない）", async () => {
      fetchMock.mockImplementation(connectFailure);
      const pending = fetchJson(options({ budgetMs: 5_000 }));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toMatchObject({ failureClass: "unreachable", attempts: 2 });
    });

    it("入力: 外から打ち切られたら timeout で、再試行しない", async () => {
      const stop = new AbortController();
      fetchMock.mockImplementation(async () => {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      });
      const result = await fetchJson(options({ signal: stop.signal }));
      expect(result).toMatchObject({ failureClass: "timeout", attempts: 1 });
    });

    it("入力: 再試行の待ちの最中に打ち切られたら、待たずに終える", async () => {
      const stop = new AbortController();
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
        throw new TypeError("fetch failed");
      });
      const pending = fetchJson(options({ signal: stop.signal }));
      await vi.advanceTimersByTimeAsync(1_000);
      stop.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toMatchObject({ failureClass: "timeout", attempts: 2 });
    });
  });
});

describe("fetchJson の rate_limited（総予算 30 秒を優先）", () => {
  describe("正常系", () => {
    it("予算ちょうどの待ちは許す", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 429, { "retry-after": "30" })).mockResolvedValueOnce(json({ a: 1 }));
      const pending = fetchJson(options());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toMatchObject({ failureClass: "ok", attempts: 2 });
    });
  });

  describe("異常系", () => {
    it("サーバ: Retry-After が予算に収まれば、その秒数だけ待って 1 回だけ再試行する", async () => {
      fetchMock.mockImplementation(async () => json({}, 429, { "retry-after": "5" }));
      const pending = fetchJson(options());
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ failureClass: "rate_limited", attempts: 2 });
    });

    it.each([
      ["無い", {}],
      ["空文字", { "retry-after": "" }],
      ["空白だけ", { "retry-after": "  " }],
    ])("空入力: Retry-After が%sなら既定の 60 秒として扱い、即座に送り直さない", async (_label, headers: Record<string, string>) => {
      fetchMock.mockImplementation(async () => json({}, 429, headers));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "rate_limited", attempts: 1 });
    });

    it("サーバ: Retry-After が予算を超えるなら、上流の指定より短く待って送り直さない", async () => {
      fetchMock.mockImplementation(async () => json({}, 429, { "retry-after": "31" }));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "rate_limited", attempts: 1 });
    });

    it("サーバ: Retry-After が日付の形（数値でない）なら既定の 60 秒として扱う", async () => {
      fetchMock.mockImplementation(async () => json({}, 429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "rate_limited", attempts: 1 });
    });

    it("サーバ: Retry-After が負の数なら既定の 60 秒として扱う", async () => {
      fetchMock.mockImplementation(async () => json({}, 429, { "retry-after": "-5" }));
      expect(await fetchJson(options())).toMatchObject({ failureClass: "rate_limited", attempts: 1 });
    });
  });
});

describe("fetchJson の Chatwoot 起動直後の 500", () => {
  describe("正常系", () => {
    it("最初のリクエストの 500 の後に通れば ok", async () => {
      fetchMock.mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json({ a: 1 }));
      const pending = fetchJson(options({ upstream: "chatwoot", firstRequest: true }));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toMatchObject({ failureClass: "ok", attempts: 2 });
    });
  });

  describe("異常系", () => {
    it("サーバ: 最初のリクエストの 500 だけ、3 秒待って 1 度だけ再試行する", async () => {
      fetchMock.mockImplementation(async () => json({}, 500));
      const pending = fetchJson(options({ upstream: "chatwoot", firstRequest: true }));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toMatchObject({ failureClass: "invalid_response", attempts: 2 });
    });

    it("サーバ: 最初のリクエストでない・Chatwoot でないなら再試行しない", async () => {
      fetchMock.mockImplementation(async () => json({}, 500));
      expect((await fetchJson(options({ upstream: "chatwoot" }))).attempts).toBe(1);
      expect((await fetchJson(options({ upstream: "github", firstRequest: true }))).attempts).toBe(1);
    });

    it("サーバ: 最初のリクエストでも 502・503 は再試行しない（500 だけ）", async () => {
      fetchMock.mockImplementation(async () => json({}, 503));
      expect((await fetchJson(options({ upstream: "chatwoot", firstRequest: true }))).attempts).toBe(1);
    });
  });
});

describe("requireSuccess", () => {
  describe("正常系", () => {
    it("ok・empty_but_ok はそのまま返す", () => {
      const ok = { failureClass: "ok" as const, attempts: 1, status: 200, data: 1 };
      expect(requireSuccess(ok, "x")).toBe(ok);
      const empty = { failureClass: "empty_but_ok" as const, attempts: 1, status: 200, data: [] };
      expect(requireSuccess(empty, "x")).toBe(empty);
    });
  });

  describe("異常系", () => {
    it("サーバ: それ以外は分類と HTTP ステータスだけを持つ IntegrationError にする", () => {
      let error: unknown;
      try {
        requireSuccess({ failureClass: "permission_denied", attempts: 1, status: 403, data: null }, "GitHub: PR の作成");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(IntegrationError);
      expect((error as IntegrationError).failureClass).toBe("permission_denied");
      expect((error as IntegrationError).name).toBe("IntegrationError");
      expect((error as IntegrationError).message).toBe("GitHub: PR の作成: permission_denied (HTTP 403)");
    });

    it("空入力: ステータスが無い（接続失敗の null）なら HTTP の部分を付けない", () => {
      expect(() => requireSuccess({ failureClass: "unreachable", attempts: 3, status: null, data: null }, "x")).toThrow(
        /^x: unreachable$/,
      );
    });

    it("空入力: 呼び出し側の説明が空文字でも、分類を含めて投げる", () => {
      expect(() => requireSuccess({ failureClass: "timeout", attempts: 2, status: null, data: null }, "")).toThrow(": timeout");
    });
  });
});
