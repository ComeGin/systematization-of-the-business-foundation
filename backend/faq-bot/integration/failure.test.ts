import { afterAll, describe, expect, it } from "vitest";
import { sign } from "../tests/helpers/chatwoot.js";
import { startBot } from "./helpers/bot.js";
import { Admin, Visitor, waitFor } from "./helpers/chatwoot.js";
import { startFaqServer } from "./helpers/faq-server.js";
import { BOT_PORT, readState } from "./helpers/state.js";

const state = readState();
const admin = new Admin(state);
const contacts: number[] = [];

afterAll(async () => {
  for (const id of contacts) await admin.deleteContact(id);
});

async function newVisitor(): Promise<Visitor> {
  const visitor = await Visitor.create(state, `it-faq-bot-${Date.now()}`);
  contacts.push(visitor.contactId);
  return visitor;
}

const openWithoutLabels = (conversationId: number) =>
  waitFor(async () => {
    const c = await admin.conversation(conversationId);
    return c.status === "open" ? c : null;
  }, "Chatwoot が会話を open にする");

describe("faq-bot の失敗（開発の Chatwoot）", () => {
  describe("異常系", () => {
    it("サーバ: faq-bot が止まっていれば、Chatwoot が会話をすぐ open にする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      expect((await openWithoutLabels(conversation_id)).labels).toEqual([]);
    });

    it("サーバ: faq.json を一度も取れていなければ、例外（502）になり、Chatwoot が会話を open にする", async () => {
      const bot = await startBot(state, "http://127.0.0.1:9/faq.json");
      try {
        const visitor = await newVisitor();
        const { conversation_id } = await visitor.say("料金は税込ですか？");
        expect((await openWithoutLabels(conversation_id)).labels).toEqual([]);
      } finally {
        await bot.stop();
      }
    });

    it("入力: 署名の違う要求は 401", async () => {
      const faq = await startFaqServer();
      const bot = await startBot(state, faq.url);
      try {
        const body = JSON.stringify({ event: "message_created" });
        const now = Math.floor(Date.now() / 1000);
        const res = await fetch(`http://127.0.0.1:${BOT_PORT}/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Chatwoot-Timestamp": String(now), "X-Chatwoot-Signature": sign("wrong-secret-0123456789", now, body) },
          body,
        });
        expect(res.status).toBe(401);
      } finally {
        await bot.stop();
        await faq.close();
      }
    });
  });

  describe("正常系", () => {
    it("空入力: 本文の無い GET /healthz は 200", async () => {
      const faq = await startFaqServer();
      const bot = await startBot(state, faq.url);
      try {
        expect((await fetch(`http://127.0.0.1:${BOT_PORT}/healthz`)).status).toBe(200);
      } finally {
        await bot.stop();
        await faq.close();
      }
    });
  });
});
