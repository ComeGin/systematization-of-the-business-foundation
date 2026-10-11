import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatwootReader } from "../../src/integrations/chatwoot.js";
import { IntegrationError } from "../../src/integrations/http.js";

const config = { baseUrl: "https://chat.example.test", accountId: 3, apiToken: "cw_read_token", agentUserId: 9 };

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const lastUrl = () => fetchMock.mock.calls.at(-1)![0] as string;

beforeEach(() => {
  // 実 Chatwoot（開発の 127.0.0.1:3100 を含む）には繋がない
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.useRealTimers());

describe("ChatwootReader.conversationsPage", () => {
  describe("正常系", () => {
    it("アカウントの API を api_access_token で読む（タイムアウト 12 秒）", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockResolvedValue(json({ data: { payload: [] } }));
      await new ChatwootReader(config).conversationsPage(2);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://chat.example.test/api/v1/accounts/3/conversations?status=all&page=2");
      expect(init.headers).toMatchObject({ api_access_token: "cw_read_token" });
      expect(timeout).toHaveBeenCalledWith(12_000);
    });

    it("id を display_id として、last_activity_at を秒からミリ秒にする", async () => {
      fetchMock.mockResolvedValue(
        json({ data: { payload: [{ id: 12, last_activity_at: 1_759_500_000 }, { id: 13 }] } }),
      );
      expect(await new ChatwootReader(config).conversationsPage(1)).toEqual([
        { displayId: 12, lastActivityMs: 1_759_500_000_000 },
        { displayId: 13, lastActivityMs: null },
      ]);
    });

    it("空入力: 0 件のページ（payload が空配列）は空配列を返す", async () => {
      fetchMock.mockResolvedValue(json({ data: { payload: [] } }));
      expect(await new ChatwootReader(config).conversationsPage(1)).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 401 は permission_denied に倒す（トークン不正と権限不足を区別できない）", async () => {
      fetchMock.mockResolvedValue(json({ error: "Invalid token" }, 401));
      const error = await new ChatwootReader(config).conversationsPage(1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntegrationError);
      expect((error as IntegrationError).failureClass).toBe("permission_denied");
    });

    it("サーバ: 起動直後の 500 の再試行は、その reader の最初のリクエストだけ", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => json({}, 500));
      const reader = new ChatwootReader(config);
      const first = reader.conversationsPage(1).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await first).toBeInstanceOf(IntegrationError);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const second = await reader.conversationsPage(2).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(IntegrationError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("サーバ: 404 は invalid_response で、エラー文にトークンを含めない", async () => {
      fetchMock.mockResolvedValue(json({ error: "Resource could not be found" }, 404));
      const error = (await new ChatwootReader(config).conversationsPage(1).catch((e: unknown) => e)) as IntegrationError;
      expect(error).toMatchObject({ name: "IntegrationError", failureClass: "invalid_response" });
      expect(error.message).toContain("HTTP 404");
      expect(error.message).not.toContain("cw_read_token");
    });

    it("サーバ: 429 は rate_limited（Retry-After が無ければ予算を超えるため待たない）", async () => {
      fetchMock.mockResolvedValue(json({}, 429));
      await expect(new ChatwootReader(config).conversationsPage(1)).rejects.toMatchObject({ failureClass: "rate_limited" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("サーバ: 接続できなければ（fetch の reject）再試行の後に unreachable", async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      const pending = new ChatwootReader(config).conversationsPage(1).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await pending).toMatchObject({ name: "IntegrationError", failureClass: "unreachable" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("サーバ: JSON でない応答（メンテナンスの HTML など）は invalid_response", async () => {
      fetchMock.mockResolvedValue(new Response("<html>maintenance</html>", { status: 200 }));
      await expect(new ChatwootReader(config).conversationsPage(1)).rejects.toMatchObject({ failureClass: "invalid_response" });
    });

    it("サーバ: 想定外の形（data が無い・id が文字列）は invalid_response", async () => {
      fetchMock.mockResolvedValueOnce(json({ payload: [] }));
      await expect(new ChatwootReader(config).conversationsPage(1)).rejects.toMatchObject({ failureClass: "invalid_response" });
      fetchMock.mockResolvedValueOnce(json({ data: { payload: [{ id: "12" }] } }));
      await expect(new ChatwootReader(config).conversationsPage(1)).rejects.toMatchObject({ failureClass: "invalid_response" });
    });

    it("空入力: 本文が空の 200 は想定外の形として invalid_response（0 件と取り違えない）", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 200 }));
      await expect(new ChatwootReader(config).conversationsPage(1)).rejects.toMatchObject({ failureClass: "invalid_response" });
    });
  });
});

describe("ChatwootReader.messages", () => {
  describe("正常系", () => {
    it("before を付けて古い方を読み、本文は捨てて ID・時刻・送信者だけ返す", async () => {
      fetchMock.mockResolvedValue(
        json({
          payload: [
            { id: 100, created_at: 1_759_500_000, message_type: 1, content: "taro@example.com", sender: { id: 9, type: "user" } },
            { id: 99, created_at: 1_759_499_000, sender: null },
          ],
        }),
      );
      const messages = await new ChatwootReader(config).messages(12, 101);
      expect(lastUrl()).toBe("https://chat.example.test/api/v1/accounts/3/conversations/12/messages?before=101");
      expect(messages).toEqual([
        { id: 100, createdAtMs: 1_759_500_000_000, messageType: 1, senderType: "user", senderId: 9 },
        { id: 99, createdAtMs: 1_759_499_000_000, messageType: null, senderType: null, senderId: null },
      ]);
      expect(JSON.stringify(messages)).not.toContain("taro@example.com");
    });

    it("before が無ければ query を付けない", async () => {
      fetchMock.mockResolvedValue(json({ payload: [] }));
      await new ChatwootReader(config).messages(12);
      expect(lastUrl()).toBe("https://chat.example.test/api/v1/accounts/3/conversations/12/messages");
    });

    it("空入力: メッセージが 0 件（payload が空配列）なら空配列を返す", async () => {
      fetchMock.mockResolvedValue(json({ payload: [] }));
      expect(await new ChatwootReader(config).messages(12)).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("サーバ: 想定外の形の応答は invalid_response の IntegrationError", async () => {
      fetchMock.mockResolvedValue(json({ payload: "x" }));
      await expect(new ChatwootReader(config).messages(1)).rejects.toMatchObject({
        name: "IntegrationError",
        failureClass: "invalid_response",
      });
    });

    it("サーバ: 403 は permission_denied で、応答の本文（個人情報を含みうる）をエラー文に残さない", async () => {
      fetchMock.mockResolvedValue(json({ error: "taro@example.com は権限がありません" }, 403));
      const error = (await new ChatwootReader(config).messages(1).catch((e: unknown) => e)) as IntegrationError;
      expect(error.failureClass).toBe("permission_denied");
      expect(error.message).not.toContain("taro@example.com");
    });

    it("サーバ: 打ち切られていたら timeout で、再試行しない", async () => {
      const stop = new AbortController();
      fetchMock.mockImplementation(async () => {
        stop.abort();
        throw new DOMException("aborted", "AbortError");
      });
      await expect(new ChatwootReader(config, stop.signal).messages(1)).rejects.toMatchObject({ failureClass: "timeout" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
