import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeError, MauticApiError, MauticClient, MauticNetworkError } from "../../src/services/mautic-client.js";

const BASE_URL = "https://mautic.example.com";
const CLIENT_ID = "client-id";
const CLIENT_SECRET = "very-secret-client-secret";
const TOKEN_URL = `${BASE_URL}/oauth/v2/token`;

type FetchArgs = [input: string | URL, init?: RequestInit];

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return json({ access_token: accessToken, expires_in: expiresIn, token_type: "bearer" });
}

/**
 * トークン取得と API 呼び出しを分けて応答する fetch の偽物。
 * 応答は「Response を返す関数」で渡す（reject させたいときは関数の中で throw する）
 */
function stubFetch(options: { tokens?: (() => Response)[]; api?: (() => Response)[] }) {
  const tokens = [...(options.tokens ?? [])];
  const api = [...(options.api ?? [])];
  let issued = 0;
  const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
    if (String(input) === TOKEN_URL) {
      const next = tokens.shift();
      issued++;
      return next ? next() : tokenResponse(`token-${issued}`);
    }
    const next = api.shift();
    return next ? next() : json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  const calls = () => fetchMock.mock.calls as FetchArgs[];
  return {
    fetchMock,
    tokenCalls: () => calls().filter(([input]) => String(input) === TOKEN_URL),
    apiCalls: () => calls().filter(([input]) => String(input) !== TOKEN_URL),
  };
}

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function newClient(): MauticClient {
  return new MauticClient({ baseUrl: BASE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
}

const networkError = () => {
  throw new TypeError("fetch failed");
};
const timeoutError = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

beforeEach(() => {
  // stubFetch を呼び忘れたテストが実ネットワーク（開発環境の 127.0.0.1 の Mautic など）に出ないよう、既定では必ず失敗させる
  vi.stubGlobal("fetch", async () => {
    throw new Error("テストが実ネットワークに出ようとした（stubFetch を呼ぶ）");
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MauticClient: OAuth2 client_credentials（トークンの取得・キャッシュ・再取得）", () => {
  describe("正常系", () => {
    it("トークンエンドポイントに client_credentials で POST する", async () => {
      const { tokenCalls } = stubFetch({});
      await newClient().get("/contacts");

      const [input, init] = tokenCalls()[0]!;
      expect(String(input)).toBe(TOKEN_URL);
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe(CLIENT_ID);
      expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    });

    it("クライアントシークレットは URL（クエリ）に載せず、body だけで送る", async () => {
      const { tokenCalls, apiCalls } = stubFetch({});
      await newClient().get("/contacts");
      expect(String(tokenCalls()[0]![0])).not.toContain(CLIENT_SECRET);
      expect(String(apiCalls()[0]![0])).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(apiCalls()[0]![1]?.headers)).not.toContain(CLIENT_SECRET);
    });

    it("トークン取得にも API 呼び出しにもタイムアウトの signal を付ける", async () => {
      const { tokenCalls, apiCalls } = stubFetch({});
      await newClient().get("/contacts");
      expect(tokenCalls()[0]![1]?.signal).toBeInstanceOf(AbortSignal);
      expect(apiCalls()[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("取得したトークンを Bearer として API に付ける", async () => {
      const { apiCalls } = stubFetch({ tokens: [() => tokenResponse("abc")] });
      await newClient().get("/contacts");
      expect(authHeader(apiCalls()[0]![1])).toBe("Bearer abc");
    });

    it("期限内のトークンはキャッシュして使い回す", async () => {
      const { tokenCalls, apiCalls } = stubFetch({});
      const client = newClient();
      await client.get("/a");
      await client.get("/b");
      expect(tokenCalls()).toHaveLength(1);
      expect(apiCalls().map(([, init]) => authHeader(init))).toEqual(["Bearer token-1", "Bearer token-1"]);
    });

    it("残り 60 秒を切る直前（61 秒前）まではキャッシュを使う", async () => {
      const { tokenCalls } = stubFetch({});
      const client = newClient();
      await client.get("/a");
      vi.setSystemTime(Date.now() + (3600 - 61) * 1000);
      await client.get("/b");
      expect(tokenCalls()).toHaveLength(1);
    });

    it("残りがちょうど 60 秒になったら取り直す", async () => {
      const { tokenCalls, apiCalls } = stubFetch({});
      const client = newClient();
      await client.get("/a");
      vi.setSystemTime(Date.now() + (3600 - 60) * 1000);
      await client.get("/b");
      expect(tokenCalls()).toHaveLength(2);
      expect(authHeader(apiCalls()[1]![1])).toBe("Bearer token-2");
    });

    it("同時に呼ばれてもトークン取得は 1 回にまとめる", async () => {
      const { tokenCalls, apiCalls } = stubFetch({});
      const client = newClient();
      await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
      expect(tokenCalls()).toHaveLength(1);
      expect(apiCalls()).toHaveLength(3);
    });

    it("401 を受けたらトークンを 1 回だけ取り直して再試行する", async () => {
      const { tokenCalls, apiCalls } = stubFetch({
        api: [() => json({ errors: [{ message: "expired", code: 401, type: null }] }, { status: 401 }), () => json({ id: 1 })],
      });
      const result = await newClient().get<{ id: number }>("/contacts/1");

      expect(result).toEqual({ id: 1 });
      expect(tokenCalls()).toHaveLength(2);
      expect(apiCalls().map(([, init]) => authHeader(init))).toEqual(["Bearer token-1", "Bearer token-2"]);
    });

    it("書き込みでも 401 の再試行は 1 回だけで、同じ body を送り直す", async () => {
      const { apiCalls } = stubFetch({ api: [() => json({}, { status: 401 }), () => json({ contact: { id: 3 } })] });
      await newClient().write("PATCH", "/contacts/3/edit", { points: 10 });
      expect(apiCalls()).toHaveLength(2);
      expect(apiCalls().map(([, init]) => init?.body)).toEqual(['{"points":10}', '{"points":10}']);
    });

    it("401 の再試行で取り直したトークンは、次の呼び出しでもキャッシュから使う", async () => {
      const { tokenCalls, apiCalls } = stubFetch({ api: [() => json({}, { status: 401 })] });
      const client = newClient();
      await client.get("/a");
      await client.get("/b");
      expect(tokenCalls()).toHaveLength(2);
      expect(apiCalls().map(([, init]) => authHeader(init))).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-2"]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 再試行でも 401 なら、それ以上は試さず 401 の MauticApiError にする", async () => {
      const unauthorized = () => json({ errors: [{ message: "denied", code: 401, type: null }] }, { status: 401 });
      const { tokenCalls, apiCalls } = stubFetch({ api: [unauthorized, unauthorized, unauthorized] });

      const error = await newClient().get("/contacts").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MauticApiError);
      expect((error as MauticApiError).status).toBe(401);
      expect(apiCalls()).toHaveLength(2);
      expect(tokenCalls()).toHaveLength(2);
    });

    it("サーバ: 401 以外のエラー（403）では再試行しない", async () => {
      const { apiCalls, tokenCalls } = stubFetch({ api: [() => json({}, { status: 403, statusText: "Forbidden" })] });
      await expect(newClient().get("/contacts")).rejects.toMatchObject({ status: 403 });
      expect(apiCalls()).toHaveLength(1);
      expect(tokenCalls()).toHaveLength(1);
    });

    it("サーバ: トークン取得の 400（invalid_client）は専用の文言の MauticApiError にし、API は呼ばない", async () => {
      const { apiCalls } = stubFetch({
        tokens: [() => json({ error: "invalid_client", error_description: "The client credentials are invalid" }, { status: 400 })],
      });
      const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;

      expect(error).toBeInstanceOf(MauticApiError);
      expect(error.status).toBe(400);
      expect(error.message).toBe("Failed to obtain Mautic access token: The client credentials are invalid");
      expect(apiCalls()).toHaveLength(0);
    });

    it("サーバ: トークン取得の 401 は 401 のまま専用の文言にし、API の 401 の再試行（取り直し）も行わない", async () => {
      const { apiCalls, tokenCalls } = stubFetch({
        tokens: [() => json({ error: "invalid_client", error_description: "Client authentication failed" }, { status: 401 })],
      });
      const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;

      expect(error).toBeInstanceOf(MauticApiError);
      expect(error.status).toBe(401);
      expect(error.message).toBe("Failed to obtain Mautic access token: Client authentication failed");
      expect(tokenCalls()).toHaveLength(1);
      expect(apiCalls()).toHaveLength(0);
    });

    it.each([
      [500, "Internal Server Error"],
      [502, "Bad Gateway"],
      [503, "Service Unavailable"],
    ])("サーバ: トークン取得の %i（JSON でないエラーページ）はステータス文言を使った専用の文言にする", async (status, statusText) => {
      const { apiCalls } = stubFetch({ tokens: [() => new Response("<html>error</html>", { status, statusText })] });
      const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;

      expect(error).toBeInstanceOf(MauticApiError);
      expect(error.status).toBe(status);
      expect(error.message).toBe(`Failed to obtain Mautic access token: ${statusText}`);
      expect(apiCalls()).toHaveLength(0);
    });

    it("サーバ: トークン取得の 429 も専用の文言にし、再試行で直らないと案内する", async () => {
      stubFetch({ tokens: [() => json({ error_description: "Too many requests" }, { status: 429 })] });
      const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;
      expect(error.status).toBe(429);
      expect(describeError(error)).toContain("cannot be fixed by retrying");
    });

    it("空入力: トークン取得の失敗応答のボディが空ならステータス文言を使う", async () => {
      stubFetch({ tokens: [() => new Response("", { status: 401, statusText: "Unauthorized" })] });
      await expect(newClient().get("/contacts")).rejects.toMatchObject({
        status: 401,
        message: "Failed to obtain Mautic access token: Unauthorized",
      });
    });

    it("サーバ: トークン取得の失敗の後の呼び出しでは、改めて取得を試みる", async () => {
      const { tokenCalls } = stubFetch({ tokens: [() => json({}, { status: 500, statusText: "Server Error" })] });
      const client = newClient();
      await expect(client.get("/a")).rejects.toBeInstanceOf(MauticApiError);
      await client.get("/b");
      expect(tokenCalls()).toHaveLength(2);
    });

    it("サーバ: 同時に呼ばれている間にトークン取得が失敗したら、全員が同じエラーで失敗し、次の呼び出しで取り直す", async () => {
      const { tokenCalls, apiCalls } = stubFetch({ tokens: [() => json({}, { status: 503, statusText: "Service Unavailable" })] });
      const client = newClient();
      const results = await Promise.allSettled([client.get("/a"), client.get("/b"), client.get("/c")]);

      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
      const reasons = results.map((result) => (result as PromiseRejectedResult).reason as MauticApiError);
      expect(new Set(reasons).size).toBe(1);
      expect(reasons[0]!.message).toBe("Failed to obtain Mautic access token: Service Unavailable");
      expect(tokenCalls()).toHaveLength(1);
      expect(apiCalls()).toHaveLength(0);

      await client.get("/d");
      expect(tokenCalls()).toHaveLength(2);
    });

    it("サーバ: 401 の再試行でトークンの取り直しに失敗したら、トークン取得失敗のエラーにして API は送り直さない", async () => {
      const { tokenCalls, apiCalls } = stubFetch({
        tokens: [() => tokenResponse("revoked"), () => json({ error_description: "The client credentials are invalid" }, { status: 400 })],
        api: [() => json({}, { status: 401 })],
      });
      const error = (await newClient().write("POST", "/contacts/new", { email: "a@example.com" }).catch((e: unknown) => e)) as MauticApiError;

      expect(error).toBeInstanceOf(MauticApiError);
      expect(error.message).toBe("Failed to obtain Mautic access token: The client credentials are invalid");
      expect(tokenCalls()).toHaveLength(2);
      expect(apiCalls()).toHaveLength(1);
    });

    it("サーバ: トークン取得の通信失敗（fetch の TypeError）は MauticNetworkError に包んで投げ、API は呼ばない", async () => {
      const { apiCalls } = stubFetch({ tokens: [networkError] });
      const error = await newClient().get("/contacts").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MauticNetworkError);
      expect((error as MauticNetworkError).cause).toBeInstanceOf(TypeError);
      expect(describeError(error)).toContain("Could not reach Mautic (network error)");
      expect(apiCalls()).toHaveLength(0);
    });

    it("サーバ: トークン取得のタイムアウト（TimeoutError）はそのまま投げ、次の呼び出しでは取り直す", async () => {
      const { tokenCalls, apiCalls } = stubFetch({ tokens: [timeoutError] });
      const client = newClient();
      const error = await client.get("/contacts").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DOMException);
      expect(describeError(error)).toContain("did not respond within 30s");
      expect(apiCalls()).toHaveLength(0);

      await client.get("/contacts");
      expect(tokenCalls()).toHaveLength(2);
    });

    it("サーバ: トークンの成功応答が JSON でなければ SyntaxError にし、API は呼ばない", async () => {
      const { apiCalls } = stubFetch({ tokens: [() => new Response("<html>login</html>", { status: 200 })] });
      const error = await newClient().get("/contacts").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SyntaxError);
      expect(describeError(error)).toContain("non-JSON response");
      expect(apiCalls()).toHaveLength(0);
    });

    // 「Authorization: Bearer undefined」で API を呼ばないよう、形の違う成功応答はトークン取得の失敗にする
    it("空入力: トークンの成功応答に access_token が無ければ、API を呼ばずにトークン取得失敗のエラーにする", async () => {
      for (const body of [{}, { access_token: "", expires_in: 3600 }, { expires_in: 3600 }, null]) {
        const { apiCalls } = stubFetch({ tokens: [() => json(body)] });
        const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;
        expect(error).toBeInstanceOf(MauticApiError);
        expect(error.message).toMatch(/^Failed to obtain Mautic access token: /);
        expect(describeError(error)).toContain("cannot be fixed by retrying");
        expect(apiCalls()).toHaveLength(0);
      }
    });

    it("入力: トークンの成功応答の expires_in が数値でなければ、API を呼ばずにトークン取得失敗のエラーにする", async () => {
      for (const expires_in of ["3600", undefined, null]) {
        const { apiCalls } = stubFetch({ tokens: [() => json({ access_token: "token-x", expires_in })] });
        const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;
        expect(error.message).toMatch(/^Failed to obtain Mautic access token: /);
        expect(apiCalls()).toHaveLength(0);
      }
    });

    it("サーバ: expires_in が 60 秒以下のトークンはキャッシュせず、呼ぶたびに取り直す", async () => {
      const { tokenCalls } = stubFetch({ tokens: [() => tokenResponse("short-1", 30), () => tokenResponse("short-2", 30)] });
      const client = newClient();
      await client.get("/a");
      await client.get("/b");
      expect(tokenCalls()).toHaveLength(2);
    });

    it("サーバ: トークン取得失敗のエラーの message に、クライアント ID・シークレットを含めない", async () => {
      stubFetch({ tokens: [() => json({ error: "invalid_client", error_description: "The client credentials are invalid" }, { status: 400 })] });
      const error = (await newClient().get("/contacts").catch((e: unknown) => e)) as MauticApiError;
      expect(error.message).not.toContain(CLIENT_SECRET);
      expect(error.message).not.toContain(CLIENT_ID);
    });
  });
});

describe("MauticClient: リクエストの組み立て", () => {
  describe("正常系", () => {
    it("baseUrl/api + path に GET し、Accept を付けて body は送らない", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().get("/emails");
      const [input, init] = apiCalls()[0]!;
      expect(String(input)).toBe(`${BASE_URL}/api/emails`);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = init?.headers as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("配列・オブジェクトのクエリを PHP 形式に展開し、null と undefined は送らない", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().get("/stats/email_stats", {
        where: [{ col: "email_id", expr: "eq", val: "5" }],
        order: ["timestamp", "DESC"],
        skip: undefined,
        empty: null,
        start: 0,
        flag: false,
      });
      const url = new URL(String(apiCalls()[0]![0]));
      expect([...url.searchParams.entries()]).toEqual([
        ["where[0][col]", "email_id"],
        ["where[0][expr]", "eq"],
        ["where[0][val]", "5"],
        ["order[0]", "timestamp"],
        ["order[1]", "DESC"],
        ["start", "0"],
        ["flag", "false"],
      ]);
    });

    it("空入力: クエリが空オブジェクトなら ? を付けない", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().get("/emails", {});
      expect(String(apiCalls()[0]![0])).toBe(`${BASE_URL}/api/emails`);
    });

    it("空入力: 空の配列・空のオブジェクトのクエリは何も送らない", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().get("/stats/page_hits", { where: [], filters: {}, start: 0 });
      expect([...new URL(String(apiCalls()[0]![0])).searchParams.entries()]).toEqual([["start", "0"]]);
    });

    it("クエリの値は URL エンコードし、パスやクエリを壊さない", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().get("/contacts", { search: "email:%@example.com&limit=1000" });
      const url = new URL(String(apiCalls()[0]![0]));
      expect(url.pathname).toBe("/api/contacts");
      expect([...url.searchParams.entries()]).toEqual([["search", "email:%@example.com&limit=1000"]]);
    });

    it("write は JSON の body と Content-Type を付けて指定のメソッドで送る", async () => {
      const { apiCalls } = stubFetch({ api: [() => json({ contact: { id: 1 } })] });
      const result = await newClient().write("POST", "/contacts/new", { email: "a@example.com" });

      const [input, init] = apiCalls()[0]!;
      expect(String(input)).toBe(`${BASE_URL}/api/contacts/new`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe('{"email":"a@example.com"}');
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(result).toEqual({ contact: { id: 1 } });
    });

    it("空入力: write の body が空オブジェクトでも {} を JSON で送る", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().write("PATCH", "/tags/1/edit", {});
      const [, init] = apiCalls()[0]!;
      expect(init?.body).toBe("{}");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("空入力: body なしの DELETE では Content-Type を付けない", async () => {
      const { apiCalls } = stubFetch({});
      await newClient().write("DELETE", "/tags/1/delete");
      const [, init] = apiCalls()[0]!;
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBeUndefined();
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    });
  });
});

describe("MauticClient.getList", () => {
  describe("正常系", () => {
    it("ID をキーにした一覧を API の並び順のまま配列にする", async () => {
      const raw = '{"total":"3","emails":{"9":{"id":9},"2":{"id":2},"5":{"id":5}},"filters":{"x":1}}';
      stubFetch({ api: [() => new Response(raw)] });
      const list = await newClient().getList<{ id: number }>("/emails", "emails");

      expect(list.items.map((item) => item.id)).toEqual([9, 2, 5]);
      expect(list.total).toBe(3);
      expect(list.meta).toEqual({ filters: { x: 1 } });
    });

    it("total がなければ items の件数を total にする", async () => {
      stubFetch({ api: [() => json({ submissions: [{ id: 1 }, { id: 2 }] })] });
      const list = await newClient().getList("/forms/1/submissions", "submissions");
      expect(list.total).toBe(2);
      expect(list.meta).toEqual({});
    });

    it.each([
      ["空のオブジェクト", '{"total":"0","emails":{}}'],
      ["空の配列", '{"total":0,"emails":[]}'],
    ])("空入力: 0 件の応答（%s）なら items は [] で total は 0", async (_label, raw) => {
      stubFetch({ api: [() => new Response(raw)] });
      const list = await newClient().getList("/emails", "emails");
      expect(list.items).toEqual([]);
      expect(list.total).toBe(0);
    });
  });

  describe("異常系", () => {
    it("空入力: property も total も無い応答（{}）は 0 件として扱う", async () => {
      stubFetch({ api: [() => json({})] });
      const list = await newClient().getList("/emails", "emails");
      expect(list).toEqual({ total: 0, items: [], meta: {} });
    });

    it("サーバ: 一覧の値が null・文字列（想定外の形）でも例外にせず items を [] にする", async () => {
      stubFetch({ api: [() => json({ total: 1, emails: null }), () => json({ total: 1, emails: "none" })] });
      const client = newClient();
      expect((await client.getList("/emails", "emails")).items).toEqual([]);
      expect((await client.getList("/emails", "emails")).items).toEqual([]);
    });

    it("サーバ: 一覧の応答が JSON でなければ SyntaxError にする", async () => {
      stubFetch({ api: [() => new Response("<html>maintenance</html>")] });
      await expect(newClient().getList("/emails", "emails")).rejects.toBeInstanceOf(SyntaxError);
    });

    it("サーバ: 一覧の取得が 5xx なら MauticApiError にする", async () => {
      stubFetch({ api: [() => json({ errors: [{ message: "Looks like I encountered an error", code: 500, type: null }] }, { status: 500 })] });
      await expect(newClient().getList("/emails", "emails")).rejects.toMatchObject({ status: 500 });
    });
  });
});

describe("MauticClient: エラー応答の解釈", () => {
  describe("異常系", () => {
    it("サーバ: errors[0].message と details を message にまとめる", async () => {
      stubFetch({
        api: [
          () =>
            json(
              { errors: [{ message: "email: A valid email is required.", code: 400, type: null, details: { email: ["A valid email is required."] } }] },
              { status: 400 },
            ),
        ],
      });
      const error = (await newClient().write("POST", "/contacts/new", { email: "x" }).catch((e: unknown) => e)) as MauticApiError;
      expect(error.status).toBe(400);
      expect(error.message).toBe('email: A valid email is required. Details: {"email":["A valid email is required."]}');
    });

    it("サーバ: details が空なら message に Details を付けない", async () => {
      stubFetch({ api: [() => json({ errors: [{ message: "Item was not found.", code: 404, type: null, details: {} }] }, { status: 404 })] });
      await expect(newClient().get("/emails/999")).rejects.toMatchObject({ status: 404, message: "Item was not found." });
    });

    it("サーバ: errors が無く error_description だけの応答はそれを message にする", async () => {
      stubFetch({ api: [() => json({ error: "access_denied", error_description: "API disabled" }, { status: 403 })] });
      await expect(newClient().get("/emails")).rejects.toMatchObject({ status: 403, message: "API disabled" });
    });

    it.each([409, 422, 429, 500, 503])("サーバ: %i はそのステータスの MauticApiError にし、再試行しない", async (status) => {
      const { apiCalls } = stubFetch({ api: [() => json({ errors: [{ message: `status ${status}`, code: status, type: null }] }, { status })] });
      await expect(newClient().get("/emails")).rejects.toMatchObject({ status, message: `status ${status}` });
      expect(apiCalls()).toHaveLength(1);
    });

    it("サーバ: JSON でない応答（プロキシのエラーページなど）はステータス文言を使う", async () => {
      stubFetch({ api: [() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" })] });
      await expect(newClient().get("/emails")).rejects.toMatchObject({ status: 502, message: "Bad Gateway" });
    });

    it("空入力: エラー応答のボディが空ならステータス文言を使う", async () => {
      stubFetch({ api: [() => new Response("", { status: 404, statusText: "Not Found" })] });
      await expect(newClient().get("/emails/1")).rejects.toMatchObject({ status: 404, message: "Not Found" });
    });

    it("サーバ: 成功応答が JSON でなければ SyntaxError になる", async () => {
      stubFetch({ api: [() => new Response("<html>ok</html>")] });
      await expect(newClient().get("/emails")).rejects.toBeInstanceOf(SyntaxError);
    });

    it("空入力: 成功応答のボディが空なら SyntaxError になる", async () => {
      stubFetch({ api: [() => new Response("")] });
      await expect(newClient().write("DELETE", "/tags/1/delete")).rejects.toBeInstanceOf(SyntaxError);
    });

    it("サーバ: API への通信失敗（fetch の TypeError）は MauticNetworkError に包んで投げ、再試行しない", async () => {
      const { apiCalls } = stubFetch({ api: [networkError] });
      await expect(newClient().get("/emails")).rejects.toBeInstanceOf(MauticNetworkError);
      expect(apiCalls()).toHaveLength(1);
    });

    it("サーバ: 本文の受信中に切れた（text() の TypeError）ときも MauticNetworkError にする", async () => {
      const body = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
        );
      stubFetch({ api: [body] });
      await expect(newClient().get("/emails")).rejects.toBeInstanceOf(MauticNetworkError);
    });

    it("サーバ: API のタイムアウト（TimeoutError）はそのまま投げ、書き込みでも送り直さない", async () => {
      const { apiCalls } = stubFetch({ api: [timeoutError] });
      const error = await newClient().write("POST", "/contacts/new", { email: "a@example.com" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("TimeoutError");
      expect(apiCalls()).toHaveLength(1);
    });
  });
});

describe("describeError", () => {
  describe("正常系", () => {
    it("404 は既定の案内を付け、notFoundHint を渡せば差し替える", () => {
      expect(describeError(new MauticApiError(404, "nope"))).toBe("Error: Not found (nope). Verify the ID first with the matching list tool.");
      expect(describeError(new MauticApiError(404, "nope"), "Try another widget.")).toBe("Error: Not found (nope). Try another widget.");
    });

    it("想定外のエラーは message を、Error 以外は文字列化して返す", () => {
      expect(describeError(new Error("boom"))).toBe("Error: Unexpected error: boom");
      expect(describeError("oops")).toBe("Error: Unexpected error: oops");
    });

    it("空入力: undefined・null を渡しても例外にせず Unexpected error の文面を返す", () => {
      expect(describeError(undefined)).toBe("Error: Unexpected error: undefined");
      expect(describeError(null)).toBe("Error: Unexpected error: null");
    });
  });

  describe("異常系", () => {
    it("サーバ: トークン取得失敗は運用者に設定の確認を求め、再試行では直らないと伝える", () => {
      const text = describeError(new MauticApiError(401, "Failed to obtain Mautic access token: invalid_client"));
      expect(text).toContain("Mautic credentials are invalid");
      expect(text).toContain("cannot be fixed by retrying");
    });

    it("サーバ: トークン取得失敗の文面にクライアントシークレットやアクセストークンを含めない", async () => {
      stubFetch({ tokens: [() => json({ error_description: "The client credentials are invalid" }, { status: 401 })] });
      const error = await newClient().get("/contacts").catch((e: unknown) => e);
      const text = describeError(error);
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(CLIENT_ID);
      expect(text).not.toMatch(/Bearer/);
    });

    it("サーバ: API の 401 の文面にアクセストークンを含めない", async () => {
      stubFetch({ api: [() => json({}, { status: 401 }), () => json({}, { status: 401 })] });
      const error = await newClient().get("/contacts").catch((e: unknown) => e);
      const text = describeError(error);
      expect(text).toBe("Error: Mautic rejected the access token even after refreshing it. Ask the operator to check the API credential in Mautic.");
      expect(text).not.toContain("token-1");
      expect(text).not.toContain("token-2");
    });

    it.each([400, 422])("サーバ: %i は入力の修正を促す", (status) => {
      expect(describeError(new MauticApiError(status, "bad field"))).toMatch(/^Error: Mautic rejected the request \(bad field\)\. Fix the listed fields/);
    });

    it("サーバ: 403 はロールの権限不足を伝える", () => {
      expect(describeError(new MauticApiError(403, "forbidden"))).toMatch(/^Error: Permission denied \(forbidden\)\..*role/);
    });

    it("サーバ: 429 は待ってから再試行するよう伝える", () => {
      expect(describeError(new MauticApiError(429, "slow down"))).toBe("Error: Rate limit exceeded. Wait a moment before retrying.");
    });

    it("サーバ: 5xx は上流の詳細を出さずにステータスだけを伝える", () => {
      const text = describeError(new MauticApiError(500, "SQLSTATE[42S22]: Column not found: secret_col"));
      expect(text).toContain("Mautic server error (500)");
      expect(text).not.toContain("SQLSTATE");
    });

    it("サーバ: その他の 4xx はステータスと message をそのまま伝える", () => {
      expect(describeError(new MauticApiError(409, "conflict"))).toBe("Error: Mautic API request failed (409): conflict");
    });

    it("サーバ: タイムアウト（TimeoutError）は秒数と絞り込みの案内を返す", () => {
      expect(describeError(new DOMException("timed out", "TimeoutError"))).toBe(
        "Error: Mautic did not respond within 30s. Retry, or narrow the request (smaller limit or date range).",
      );
    });

    it("サーバ: TimeoutError 以外の DOMException（AbortError）はタイムアウトと伝えない", () => {
      expect(describeError(new DOMException("aborted", "AbortError"))).toBe("Error: Unexpected error: aborted");
    });

    it("サーバ: SyntaxError は JSON 以外の応答として説明する", () => {
      expect(describeError(new SyntaxError("Unexpected token <"))).toContain("non-JSON response");
    });

    it("サーバ: MauticNetworkError はネットワークエラーとして説明し、元のエラーの原文（URL などを含みうる）は出さない", () => {
      const text = describeError(new MauticNetworkError(new TypeError(`fetch failed ${BASE_URL}?secret=${CLIENT_SECRET}`)));
      expect(text).toBe("Error: Could not reach Mautic (network error). Check that Mautic and its public URL (ngrok) are running.");
    });

    // fetch の TypeError は MauticNetworkError に包み直すため、素の TypeError はツール側の整形中（contact がないなど）に起きたもの
    it("サーバ: 素の TypeError は通信失敗ではなく、応答の形が想定外と説明する", () => {
      const text = describeError(new TypeError("Cannot read properties of undefined (reading 'id')"));
      expect(text).toMatch(/^Error: Unexpected response shape from Mautic \(Cannot read properties of undefined \(reading 'id'\)\)\. /);
      expect(text).toContain("Check the current state with the matching get or list tool before retrying a write.");
      expect(text).not.toContain("Could not reach");
    });
  });
});
