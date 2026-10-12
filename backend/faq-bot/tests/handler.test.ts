import { describe, expect, it, vi } from "vitest";
import { ChatwootApiError, type ChatwootClient } from "../src/chatwoot/client.js";
import type { ConversationStatus, ConversationView } from "../src/chatwoot/types.js";
import { MESSAGES } from "../src/constants.js";
import type { FaqItem } from "../src/faq/schema.js";
import { buildSnapshot, FaqUnavailableError, type FaqSource } from "../src/faq/store.js";
import { createHandler, type HttpRequest } from "../src/handler.js";
import { conversationUpdatedPayload, labelChange, questionPayload, sign, welcomePayload } from "./helpers/chatwoot.js";
import { makeConfig } from "./helpers/config.js";
import { makeFaqItem } from "./helpers/faq.js";

const NOW = 1_800_000_000;
const CONFIG = makeConfig();

function setup(
  options: { faqFails?: boolean; clientFails?: boolean; faqItems?: FaqItem[]; createdStatus?: ConversationStatus; conversation?: Partial<ConversationView> } = {},
) {
  const faq: FaqSource = {
    current: vi.fn(async () => {
      if (options.faqFails) throw new FaqUnavailableError("faq.json をまだ一度も取得できていない");
      return buildSnapshot(options.faqItems ?? [makeFaqItem()], 0);
    }),
  };
  const client = {
    getConversation: vi.fn(async () => {
      if (options.clientFails) throw new ChatwootApiError(503, "GET conversations/12", "HTTP 503");
      return {
        status: "pending" as ConversationStatus,
        labels: [] as readonly string[],
        lastMessage: { id: 101, messageType: 0, senderType: "contact", inReplyTo: null },
        ...options.conversation,
      };
    }),
    createConversation: vi.fn(async () => {
      if (options.clientFails) throw new ChatwootApiError(503, "POST conversations", "HTTP 503");
      return { id: 31, status: options.createdStatus ?? ("pending" as const) };
    }),
    getLabels: vi.fn(async () => (options.conversation?.labels ?? []) as readonly string[]),
    sendMessage: vi.fn(async () => {}),
    setLabels: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
  } satisfies ChatwootClient;
  const log = vi.fn();
  const handle = createHandler({ config: CONFIG, faq, client, nowSeconds: () => NOW, log });
  return { handle, client, faq, log };
}

function signed(body: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "POST",
    path: "/webhook",
    headers: { "x-chatwoot-timestamp": String(NOW), "x-chatwoot-signature": sign(CONFIG.CHATWOOT_BOT_SECRET, NOW, body) },
    body: Buffer.from(body),
    ...overrides,
  };
}

describe("createHandler", () => {
  describe("正常系", () => {
    it("GET /healthz は 200", async () => {
      const { handle } = setup();
      expect(await handle({ method: "GET", path: "/healthz", headers: {}, body: Buffer.alloc(0) })).toEqual({ status: 200, body: '{"ok":true}' });
    });

    it("署名つきの質問に答え、本文を含まないログを 1 行出す", async () => {
      const { handle, client, log } = setup();
      const res = await handle(signed(JSON.stringify(questionPayload())));
      expect(res).toEqual({ status: 200, body: '{"result":"done"}' });
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ conversation: 12, event: "question", decision: "answer", outcome: "done" }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("料金は税込");
    });

    it("扱わないイベントは 200 で何もしない", async () => {
      const { handle, client } = setup();
      expect(await handle(signed(JSON.stringify({ event: "conversation_status_changed", id: 12 })))).toEqual({ status: 200, body: '{"result":"ignored"}' });
      expect(client.getConversation).not.toHaveBeenCalled();
    });

    it("別のアカウントのイベントは 200 で何もしない", async () => {
      const { handle, client } = setup();
      const res = await handle(signed(JSON.stringify(questionPayload({ account: { id: 2 } }))));
      expect(res.body).toBe('{"result":"ignored"}');
      expect(client.getConversation).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("空入力: 署名つきの空の本文は 400", async () => {
      const { handle } = setup();
      expect((await handle(signed(""))).status).toBe(400);
    });

    it("入力: 署名が無ければ 401（理由だけをログに出す）", async () => {
      const { handle, client, log } = setup();
      const res = await handle({ method: "POST", path: "/webhook", headers: {}, body: Buffer.from("{}") });
      expect(res.status).toBe(401);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ result: "unauthorized", reason: "missing" }));
      expect(client.getConversation).not.toHaveBeenCalled();
    });

    it("入力: 署名が違えば 401", async () => {
      const { handle } = setup();
      const req = signed(JSON.stringify(questionPayload()));
      expect((await handle({ ...req, body: Buffer.from(`${req.body.toString()} `) })).status).toBe(401);
    });

    it("入力: 64 KB を超える本文は 413", async () => {
      const { handle } = setup();
      expect((await handle(signed("x".repeat(64 * 1024 + 1)))).status).toBe(413);
    });

    it("入力: 知らないパスは 404、GET /webhook は 405", async () => {
      const { handle } = setup();
      expect((await handle(signed("{}", { path: "/other" }))).status).toBe(404);
      expect((await handle(signed("{}", { method: "GET" }))).status).toBe(405);
    });

    it("入力: JSON でない本文は 400", async () => {
      const { handle } = setup();
      expect(await handle(signed("not json"))).toEqual({ status: 400, body: '{"error":"invalid_json"}' });
    });

    it("入力: 形の壊れたイベントは 400", async () => {
      const { handle } = setup();
      const { conversation: _omit, ...rest } = questionPayload();
      expect(await handle(signed(JSON.stringify(rest)))).toEqual({ status: 400, body: '{"error":"invalid_event"}' });
    });

    it("サーバ: faq.json が一度も取れていなければ例外", async () => {
      const { handle } = setup({ faqFails: true });
      await expect(handle(signed(JSON.stringify(questionPayload())))).rejects.toBeInstanceOf(FaqUnavailableError);
    });

    it("サーバ: Chatwoot の API の失敗は例外", async () => {
      const { handle } = setup({ clientFails: true });
      await expect(handle(signed(JSON.stringify(questionPayload())))).rejects.toBeInstanceOf(ChatwootApiError);
    });
  });
});

describe("createHandler（ウィジェットを開いたとき）", () => {
  const SOURCE_ID = "3f1c2b9e-0000-4000-8000-000000000000";

  describe("正常系", () => {
    it("会話の無い訪問者が開いたら、会話を作って一覧を 1 通送り、source_id を含まないログを 1 行出す", async () => {
      const { handle, client, log } = setup();
      expect(await handle(signed(JSON.stringify(welcomePayload())))).toEqual({ status: 200, body: '{"result":"welcome"}' });
      expect(client.createConversation).toHaveBeenCalledWith(SOURCE_ID, 3);
      expect(client.sendMessage).toHaveBeenCalledWith(
        31,
        { kind: "select", content: MESSAGES.welcome, items: [{ title: "料金は税込ですか？", value: "top-3" }] },
        null,
      );
      expect(client.getConversation).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "welcome", decision: "welcome", conversation: 31, faq: ["top-3"], contact_inbox: 55 }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(SOURCE_ID);
    });

    // 2026-10-12 の最終レビュー（Minor）: 素早く 2 回開いた同じ訪問者を、ログだけで追えるようにする（source_id は出さない）
    it("一覧を出さなかった行（skip-*）にも ContactInbox の id を出す", async () => {
      const { handle, log } = setup({ faqItems: [makeFaqItem({ id: "pricing-1" })] });
      await handle(signed(JSON.stringify(welcomePayload())));
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ decision: "skip-empty", contact_inbox: 55 }));
    });

    it("直前の会話が resolved なら、新しい会話を作って一覧を出す", async () => {
      const { handle, client } = setup();
      const res = await handle(signed(JSON.stringify(welcomePayload({ current_conversation: { id: 40, status: "resolved" } }))));
      expect(res.body).toBe('{"result":"welcome"}');
      expect(client.createConversation).toHaveBeenCalledTimes(1);
    });

    it("進行中の会話（pending・open・snoozed）があれば何もしない（FAQ も読まない）", async () => {
      for (const status of ["pending", "open", "snoozed"]) {
        const { handle, client, faq, log } = setup();
        const res = await handle(signed(JSON.stringify(welcomePayload({ current_conversation: { id: 41, status } }))));
        expect(res).toEqual({ status: 200, body: '{"result":"skip-active"}' });
        expect(client.createConversation).not.toHaveBeenCalled();
        expect(faq.current).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "welcome", decision: "skip-active" }));
      }
    });

    it("空入力: トップページの項目が無ければ、会話を作らない", async () => {
      const { handle, client } = setup({ faqItems: [makeFaqItem({ id: "pricing-1" })] });
      expect((await handle(signed(JSON.stringify(welcomePayload())))).body).toBe('{"result":"skip-empty"}');
      expect(client.createConversation).not.toHaveBeenCalled();
    });

    it("作った会話が pending でなければ送らない", async () => {
      const { handle, client, log } = setup({ createdStatus: "resolved" });
      expect((await handle(signed(JSON.stringify(welcomePayload())))).body).toBe('{"result":"skip-not-pending"}');
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ decision: "skip-not-pending", conversation: 31 }));
    });

    it("別のアカウントの webwidget_triggered は 200 で何もしない", async () => {
      const { handle, client } = setup();
      expect((await handle(signed(JSON.stringify(welcomePayload({ account: { id: 2 } }))))).body).toBe('{"result":"ignored"}');
      expect(client.createConversation).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: faq.json が一度も取れていなければ例外（会話を作らない）", async () => {
      const { handle, client } = setup({ faqFails: true });
      await expect(handle(signed(JSON.stringify(welcomePayload())))).rejects.toBeInstanceOf(FaqUnavailableError);
      expect(client.createConversation).not.toHaveBeenCalled();
    });

    it("サーバ: 会話の作成の失敗は例外", async () => {
      const { handle } = setup({ clientFails: true });
      await expect(handle(signed(JSON.stringify(welcomePayload())))).rejects.toBeInstanceOf(ChatwootApiError);
    });

    it("入力: 形の壊れた webwidget_triggered は 400", async () => {
      const { handle } = setup();
      expect(await handle(signed(JSON.stringify(welcomePayload({ source_id: "" }))))).toEqual({ status: 400, body: '{"error":"invalid_event"}' });
    });

    // 2026-10-12 の最終レビュー（Minor）: Chatwoot の更新で本文の形が変わると、一覧が黙って止まる。どの項目が違うかだけを warn で出す
    it("入力: 形の壊れた本文で 400 を返すとき、違う項目の名前だけを warn のログに出す（値は出さない）", async () => {
      const { handle, log } = setup();
      await handle(signed(JSON.stringify(welcomePayload({ current_conversation: { id: 40, status: "bot-secret-value" } }))));
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", result: "invalid_event", reason: expect.stringContaining("current_conversation.status") }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("bot-secret-value");
      expect(JSON.stringify(log.mock.calls)).not.toContain(SOURCE_ID);
    });
  });
});

describe("createHandler（担当者のマクロ「解決の確認を送る」）", () => {
  describe("正常系", () => {
    it("ラベル faq-ask-resolved が付いたら、ラベルを外してから［解決しました］ボタンを送り、ログを 1 行出す", async () => {
      const { handle, client, log } = setup({ conversation: { status: "open", labels: ["faq-handoff", "faq-ask-resolved"] } });
      expect(await handle(signed(JSON.stringify(conversationUpdatedPayload())))).toEqual({ status: 200, body: '{"result":"ask-resolved"}' });
      expect(client.setLabels).toHaveBeenCalledWith(12, ["faq-handoff"]);
      expect(client.sendMessage).toHaveBeenCalledWith(12, { kind: "select", content: MESSAGES.askResolved, items: [{ title: "解決しました", value: "__resolved" }] }, null);
      expect(client.setLabels.mock.invocationCallOrder[0]).toBeLessThan(client.sendMessage.mock.invocationCallOrder[0]!);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "ask-resolved", conversation: 12, decision: "ask-resolved" }));
    });

    it("ラベル faq-ask-resolved が今付いたのでない会話の更新は、Chatwoot の API を呼ばずに 200 で何もしない", async () => {
      const { handle, client } = setup();
      const event = conversationUpdatedPayload({ labels: ["faq-answered"], changed_attributes: labelChange([], ["faq-answered"]) });
      expect((await handle(signed(JSON.stringify(event)))).body).toBe('{"result":"ignored"}');
      expect(client.getConversation).not.toHaveBeenCalled();
    });

    it("解決済みの会話では何もしない（skip-resolved）", async () => {
      const { handle, client } = setup({ conversation: { status: "resolved", labels: ["faq-ask-resolved"] } });
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload())))).body).toBe('{"result":"skip-resolved"}');
      expect(client.setLabels).not.toHaveBeenCalled();
    });

    it("読み直したらラベルがもう無ければ何もしない（skip-no-label）", async () => {
      const { handle, client } = setup({ conversation: { status: "open", labels: ["faq-handoff"] } });
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload())))).body).toBe('{"result":"skip-no-label"}');
      expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("別のアカウントの会話の更新は 200 で何もしない", async () => {
      const { handle, client } = setup();
      expect((await handle(signed(JSON.stringify(conversationUpdatedPayload({ account: { id: 2 } }))))).body).toBe('{"result":"ignored"}');
      expect(client.getConversation).not.toHaveBeenCalled();
    });
  });

  describe("異常系", () => {
    it("サーバ: Chatwoot の API の失敗は例外", async () => {
      const { handle } = setup({ clientFails: true });
      await expect(handle(signed(JSON.stringify(conversationUpdatedPayload())))).rejects.toBeInstanceOf(ChatwootApiError);
    });
  });
});
