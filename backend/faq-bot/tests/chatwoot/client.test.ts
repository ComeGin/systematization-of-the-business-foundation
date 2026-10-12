import { describe, expect, it } from "vitest";
import { ChatwootApiError, createChatwootClient } from "../../src/chatwoot/client.js";
import { jsonResponse } from "../helpers/faq.js";
import { recordingFetch } from "../helpers/http.js";

const BASE = "https://chat.comegin.com/api/v1/accounts/1/conversations";
const makeClient = (fetchImpl: typeof fetch) =>
  createChatwootClient({ baseUrl: "https://chat.comegin.com", accountId: 1, token: "bot-token", timeoutMs: 2_000, fetchImpl });

const SHOW = {
  id: 12,
  status: "pending",
  labels: ["vip"],
  messages: [{ id: 300, message_type: 2 }],
  last_non_activity_message: { id: 101, message_type: 0, sender: { id: 7, type: "contact" } },
};

describe("createChatwootClient", () => {
  describe("正常系", () => {
    it("getConversation は show を読み、last_non_activity_message を使う", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse(SHOW));
      expect(await makeClient(fetchImpl).getConversation(12)).toEqual({
        status: "pending",
        labels: ["vip"],
        lastMessage: { id: 101, messageType: 0, senderType: "contact", inReplyTo: null },
      });
      expect(calls[0]).toMatchObject({ url: `${BASE}/12`, method: "GET", headers: { api_access_token: "bot-token" } });
    });

    it("ボットの返事の in_reply_to を読む", async () => {
      const { fetchImpl } = recordingFetch(
        jsonResponse({ ...SHOW, last_non_activity_message: { id: 400, message_type: 1, content_attributes: { in_reply_to: 101, items: [] }, sender: { type: "agent_bot" } } }),
      );
      expect((await makeClient(fetchImpl).getConversation(12)).lastMessage).toEqual({ id: 400, messageType: 1, senderType: "agent_bot", inReplyTo: 101 });
    });

    it("空入力: メッセージもラベルも無い会話", async () => {
      const { fetchImpl } = recordingFetch(jsonResponse({ id: 12, status: "pending", labels: null, last_non_activity_message: null }));
      expect(await makeClient(fetchImpl).getConversation(12)).toEqual({ status: "pending", labels: [], lastMessage: null });
    });

    it("sendMessage（text）は outgoing と in_reply_to を送る", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 400 }));
      await makeClient(fetchImpl).sendMessage(12, { kind: "text", content: "担当者におつなぎします。" }, 101);
      expect(calls[0]).toMatchObject({
        url: `${BASE}/12/messages`,
        method: "POST",
        body: { content: "担当者におつなぎします。", message_type: "outgoing", private: false, content_attributes: { in_reply_to: 101 } },
      });
    });

    it("sendMessage（select）は input_select と items を送る", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 401 }));
      const items = [{ title: "解決しました", value: "__resolved" }];
      await makeClient(fetchImpl).sendMessage(12, { kind: "select", content: "答え", items }, 101);
      expect(calls[0]?.body).toEqual({
        content: "答え",
        message_type: "outgoing",
        private: false,
        content_type: "input_select",
        content_attributes: { items, in_reply_to: 101 },
      });
    });

    it("setLabels はラベルの一覧を送る（付け替え）", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ payload: ["vip", "faq-answered"] }));
      await makeClient(fetchImpl).setLabels(12, ["vip", "faq-answered"]);
      expect(calls[0]).toMatchObject({ url: `${BASE}/12/labels`, method: "POST", body: { labels: ["vip", "faq-answered"] } });
    });

    it("getLabels は会話の今のラベルを読む（書き込む直前の読み直しに使う）", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ payload: ["vip", "faq-ask-resolved"] }));
      expect(await makeClient(fetchImpl).getLabels(12)).toEqual(["vip", "faq-ask-resolved"]);
      expect(calls[0]).toMatchObject({ url: `${BASE}/12/labels`, method: "GET" });
    });

    it("空入力: getLabels はラベルの無い会話で空の一覧", async () => {
      const { fetchImpl } = recordingFetch(jsonResponse({ payload: [] }));
      expect(await makeClient(fetchImpl).getLabels(12)).toEqual([]);
    });

    it("空入力: setLabels は空の一覧も送る", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ payload: [] }));
      await makeClient(fetchImpl).setLabels(12, []);
      expect(calls[0]?.body).toEqual({ labels: [] });
    });

    it("setStatus は toggle_status を呼ぶ", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ payload: { success: true } }));
      await makeClient(fetchImpl).setStatus(12, "open");
      expect(calls[0]).toMatchObject({ url: `${BASE}/12/toggle_status`, method: "POST", body: { status: "open" } });
    });

    it("空入力: 本文の無い 200 も成功として扱う", async () => {
      const { fetchImpl } = recordingFetch(new Response("", { status: 200 }));
      await expect(makeClient(fetchImpl).setStatus(12, "resolved")).resolves.toBeUndefined();
    });

    it("createConversation は source_id と inbox_id で会話を作り、番号とステータスを返す（status は渡さない）", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 31, status: "pending", inbox_id: 3, messages: [], meta: { sender: { id: 7 } } }));
      expect(await makeClient(fetchImpl).createConversation("3f1c2b9e-0000-4000-8000-000000000000", 3)).toEqual({ id: 31, status: "pending" });
      expect(calls[0]).toMatchObject({ url: BASE, method: "POST", headers: { api_access_token: "bot-token" } });
      expect(calls[0]!.body).toEqual({ source_id: "3f1c2b9e-0000-4000-8000-000000000000", inbox_id: 3 });
    });

    it("sendMessage（select）は in_reply_to が null なら送らない（一覧のメッセージ）", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 401 }));
      const items = [{ title: "料金は税込ですか？", value: "top-3" }];
      await makeClient(fetchImpl).sendMessage(31, { kind: "select", content: "よくあるご質問です。", items }, null);
      expect(calls[0]!.body).toEqual({
        content: "よくあるご質問です。",
        message_type: "outgoing",
        private: false,
        content_type: "input_select",
        content_attributes: { items },
      });
    });

    it("sendMessage（text）は in_reply_to が null なら content_attributes を送らない", async () => {
      const { fetchImpl, calls } = recordingFetch(jsonResponse({ id: 402 }));
      await makeClient(fetchImpl).sendMessage(31, { kind: "text", content: "こんにちは" }, null);
      expect(calls[0]!.body).toEqual({ content: "こんにちは", message_type: "outgoing", private: false });
    });
  });

  describe("異常系", () => {
    it("サーバ: 4xx は ChatwootApiError（応答の本文はメッセージに入れない）", async () => {
      const { fetchImpl } = recordingFetch(new Response('{"error":"secret-detail jane@example.com"}', { status: 401 }));
      const error = await makeClient(fetchImpl).getConversation(12).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatwootApiError);
      expect((error as ChatwootApiError).status).toBe(401);
      expect((error as Error).message).not.toContain("jane@example.com");
    });

    it("サーバ: 5xx は ChatwootApiError", async () => {
      const { fetchImpl } = recordingFetch(new Response("", { status: 503 }));
      await expect(makeClient(fetchImpl).sendMessage(12, { kind: "text", content: "x" }, 1)).rejects.toMatchObject({ status: 503 });
    });

    it("サーバ: 接続できなければ status 0", async () => {
      const { fetchImpl } = recordingFetch(new TypeError("fetch failed"));
      await expect(makeClient(fetchImpl).setLabels(12, ["a"])).rejects.toMatchObject({ status: 0, message: expect.stringContaining("接続できない") });
    });

    it("サーバ: タイムアウトは status 0 で「タイムアウト」", async () => {
      const { fetchImpl } = recordingFetch(new DOMException("timed out", "TimeoutError"));
      await expect(makeClient(fetchImpl).getConversation(12)).rejects.toMatchObject({ status: 0, message: expect.stringContaining("タイムアウト") });
    });

    it("サーバ: JSON でない応答は ChatwootApiError", async () => {
      const { fetchImpl } = recordingFetch(new Response("<html>", { status: 200 }));
      await expect(makeClient(fetchImpl).getConversation(12)).rejects.toBeInstanceOf(ChatwootApiError);
    });

    it("入力: 知らないステータスの会話は ChatwootApiError", async () => {
      const { fetchImpl } = recordingFetch(jsonResponse({ ...SHOW, status: "archived" }));
      await expect(makeClient(fetchImpl).getConversation(12)).rejects.toBeInstanceOf(ChatwootApiError);
    });

    it("入力: getLabels の応答の形が違えば ChatwootApiError", async () => {
      const { fetchImpl } = recordingFetch(jsonResponse({ labels: ["vip"] }));
      await expect(makeClient(fetchImpl).getLabels(12)).rejects.toBeInstanceOf(ChatwootApiError);
    });

    it("入力: createConversation の応答の形が違えば ChatwootApiError（本文は入れない）", async () => {
      const { fetchImpl } = recordingFetch(jsonResponse({ id: "31", status: "pending" }));
      const error = await makeClient(fetchImpl).createConversation("s", 3).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatwootApiError);
      expect((error as Error).message).toBe("POST conversations: 応答の形が違う");
    });
  });
});
