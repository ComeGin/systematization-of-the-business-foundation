import { describe, expect, it, vi } from "vitest";

import { HTTP_TIMEOUT_MS } from "../../src/constants.js";
import { ChatwootApiError, ChatwootClient, describeError } from "../../src/services/chatwoot-client.js";
import { installFetch, V1, V2 } from "../helpers/fetch.js";
import { ACCESS_TOKEN, BASE_URL } from "../helpers/server.js";

function client(): ChatwootClient {
  return new ChatwootClient({ baseUrl: BASE_URL, accessToken: ACCESS_TOKEN, accountId: 1 });
}

describe("ChatwootClient.request", () => {
  describe("URL の組み立て", () => {
    it("既定（v1）はアカウント配下の /api/v1/accounts/{id} に付ける", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/conversations/42");
      expect(calls[0]!.url.origin).toBe(BASE_URL);
      expect(calls[0]!.path).toBe(`${V1}/conversations/42`);
    });

    it("scope=v2 は /api/v2/accounts/{id}、scope=root はアカウント外の /api/v1 に付ける", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/reports/summary", { scope: "v2" });
      await client().get("/profile", { scope: "root" });
      expect(calls.map((call) => call.path)).toEqual([`${V2}/reports/summary`, "/api/v1/profile"]);
    });

    it("配列のクエリは Rails 形式（key[]=a&key[]=b）に展開する", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/conversations", { query: { labels: ["billing", "vip"], inbox_id: 3 } });
      expect(calls[0]!.query.getAll("labels[]")).toEqual(["billing", "vip"]);
      expect(calls[0]!.query.get("inbox_id")).toBe("3");
    });

    it("undefined・null・空文字のクエリは送らず、false と 0 は送る", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/x", { query: { a: undefined, b: null, c: "", d: false, e: 0 } });
      expect([...calls[0]!.query.keys()]).toEqual(["d", "e"]);
      expect(calls[0]!.query.get("d")).toBe("false");
      expect(calls[0]!.query.get("e")).toBe("0");
    });
  });

  describe("ヘッダーと本文", () => {
    it("ユーザーのアクセストークンを api_access_token ヘッダーで送る（Authorization ではない）", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/agents");
      expect(calls[0]!.headers.api_access_token).toBe(ACCESS_TOKEN);
      expect(calls[0]!.headers.Accept).toBe("application/json");
      expect(calls[0]!.headers).not.toHaveProperty("Authorization");
    });

    it("トークンをクエリ文字列に載せない", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/agents", { query: { q: "x" } });
      expect(calls[0]!.url.href).not.toContain(ACCESS_TOKEN);
    });

    it("本文があるときだけ JSON にして Content-Type を付ける", async () => {
      const { calls } = installFetch(() => ({ json: {} }));
      await client().request("POST", "/labels", { label: { title: "billing" } });
      await client().request("DELETE", "/labels/3");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
      expect(calls[0]!.rawBody).toBe(JSON.stringify({ label: { title: "billing" } }));
      expect(calls[1]!.method).toBe("DELETE");
      expect(calls[1]!.headers).not.toHaveProperty("Content-Type");
      expect(calls[1]!.rawBody).toBeUndefined();
    });

    it(`${HTTP_TIMEOUT_MS} ミリ秒のタイムアウトを付ける`, async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const { calls } = installFetch(() => ({ json: {} }));
      await client().get("/agents");
      expect(timeout).toHaveBeenCalledWith(HTTP_TIMEOUT_MS);
      expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("レスポンス", () => {
    it("JSON の本文を解釈して返す", async () => {
      installFetch(() => ({ json: { payload: [1, 2] } }));
      await expect(client().get("/labels")).resolves.toEqual({ payload: [1, 2] });
    });

    it("本文が空（head :ok）なら null を返す", async () => {
      installFetch(() => ({ text: "  \n" }));
      await expect(client().request("DELETE", "/labels/3")).resolves.toBeNull();
    });

    it("成功応答が JSON でないときは SyntaxError になる", async () => {
      installFetch(() => ({ text: "<html>proxy</html>" }));
      await expect(client().get("/x")).rejects.toBeInstanceOf(SyntaxError);
    });
  });

  describe("エラー応答", () => {
    async function errorFrom(response: { status: number; json?: unknown; text?: string; statusText?: string }): Promise<ChatwootApiError> {
      installFetch(() => response);
      const error = await client()
        .get("/x")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatwootApiError);
      return error as ChatwootApiError;
    }

    it("{ error: 文字列 } はその文字列をメッセージにする", async () => {
      const error = await errorFrom({ status: 401, json: { error: "Invalid Access Token" } });
      expect(error.status).toBe(401);
      expect(error.message).toBe("Invalid Access Token");
    });

    it("{ error: オブジェクト } は JSON 文字列にする", async () => {
      const error = await errorFrom({ status: 422, json: { error: { title: ["has already been taken"] } } });
      expect(error.message).toBe('{"title":["has already been taken"]}');
    });

    it("{ message, attributes } は項目名を付け足す", async () => {
      const error = await errorFrom({ status: 422, json: { message: "Email has already been taken", attributes: ["email", "identifier"] } });
      expect(error.message).toBe("Email has already been taken (fields: email, identifier)");
    });

    it("{ errors: [...] } も拾う", async () => {
      const error = await errorFrom({ status: 422, json: { errors: ["Name can't be blank"] } });
      expect(error.message).toBe('["Name can\'t be blank"]');
    });

    it("本文が JSON でないときはステータス文言を使う", async () => {
      const error = await errorFrom({ status: 502, text: "<html>Bad Gateway</html>", statusText: "Bad Gateway" });
      expect(error.status).toBe(502);
      expect(error.message).toBe("Bad Gateway");
    });
  });
});

describe("describeError", () => {
  const api = (status: number, message = "detail") => new ChatwootApiError(status, message);

  it("400 / 422 は拒否理由と「項目を直して再試行」を返す", () => {
    for (const status of [400, 422]) {
      const text = describeError(api(status, "title is invalid"));
      expect(text).toContain("rejected the request (title is invalid)");
      expect(text).toContain("Fix the listed fields");
    }
  });

  it("401 の Invalid Access Token は再試行で直らないことと変数名だけを伝え、トークンの値は含めない", () => {
    const text = describeError(api(401, "Invalid Access Token"));
    expect(text).toContain("rejected the access token");
    expect(text).toContain("CHATWOOT_API_ACCESS_TOKEN");
    expect(text).not.toContain(ACCESS_TOKEN);
  });

  it("それ以外の 401 は権限不足（ロール）として伝える", () => {
    expect(describeError(api(401, "You are not authorized to do this action"))).toContain("Permission denied");
  });

  it("402 はプラン・エディションの制限として伝える", () => {
    expect(describeError(api(402))).toContain("not available on the current Chatwoot plan");
  });

  it("403 は API 無効化の可能性を伝える", () => {
    expect(describeError(api(403))).toContain("If API access is disabled");
  });

  it("404 は既定の案内、または呼び出し元の案内を付ける", () => {
    expect(describeError(api(404, "missing"))).toBe("Error: Not found (missing). Verify the ID first with the matching list tool.");
    expect(describeError(api(404, "missing"), "Use #number.")).toBe("Error: Not found (missing). Use #number.");
  });

  it("429 は待ってから再試行するよう伝える", () => {
    expect(describeError(api(429))).toBe("Error: Rate limit exceeded. Wait a moment before retrying.");
  });

  it("5xx はサーバエラーとして、本文の詳細ではなくステータスだけを返す", () => {
    const text = describeError(api(500, "stack trace with internals"));
    expect(text).toContain("Chatwoot server error (500)");
    expect(text).not.toContain("stack trace");
  });

  it("その他の 4xx はステータスと詳細を返す", () => {
    expect(describeError(api(409, "conflict"))).toBe("Error: Chatwoot API request failed (409): conflict");
  });

  it("RangeError（送信前の日付検証）はメッセージをそのまま返す", () => {
    expect(describeError(new RangeError("since must be earlier than until."))).toBe("Error: since must be earlier than until.");
  });

  it("タイムアウトは秒数と絞り込みの案内を返す", () => {
    expect(describeError(new DOMException("timed out", "TimeoutError"))).toContain(`within ${HTTP_TIMEOUT_MS / 1000}s`);
  });

  it("JSON でない応答（SyntaxError）はプロキシのエラーページの可能性を伝える", () => {
    expect(describeError(new SyntaxError("Unexpected token <"))).toContain("non-JSON response");
  });

  it("ネットワークエラー（TypeError）は原文（URL などを含みうる）を返さず、変数名で案内する", () => {
    const text = describeError(new TypeError(`fetch failed ${BASE_URL}?api_access_token=${ACCESS_TOKEN}`));
    expect(text).toContain("CHATWOOT_BASE_URL");
    expect(text).not.toContain(ACCESS_TOKEN);
    expect(text).not.toContain(BASE_URL);
  });

  it("想定外のエラーはメッセージを、Error 以外は文字列化して返す", () => {
    expect(describeError(new Error("boom"))).toBe("Error: Unexpected error: boom");
    expect(describeError("plain")).toBe("Error: Unexpected error: plain");
  });

  it("実際の 401 応答からも、トークンを含まない文面になる", async () => {
    installFetch(() => ({ status: 401, json: { error: "Invalid Access Token" } }));
    const error = await new ChatwootClient({ baseUrl: BASE_URL, accessToken: ACCESS_TOKEN, accountId: 1 }).get("/x").catch((e: unknown) => e);
    expect(describeError(error)).not.toContain(ACCESS_TOKEN);
  });
});
