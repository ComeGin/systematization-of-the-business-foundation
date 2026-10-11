import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MESSAGES } from "../src/constants.js";
import { startBot } from "./helpers/bot.js";
import { Admin, botMessage, Visitor, waitFor } from "./helpers/chatwoot.js";
import { startFaqServer } from "./helpers/faq-server.js";
import { readState } from "./helpers/state.js";

const state = readState();
const admin = new Admin(state);
const contacts: number[] = [];
let stopBot: () => Promise<void>;
let stopFaq: () => Promise<void>;

beforeAll(async () => {
  const faq = await startFaqServer();
  stopFaq = faq.close;
  stopBot = (await startBot(state, faq.url)).stop;
});

afterAll(async () => {
  await stopBot?.();
  await stopFaq?.();
  for (const id of contacts) await admin.deleteContact(id);
});

async function newVisitor(): Promise<Visitor> {
  const visitor = await Visitor.create(state, `it-faq-bot-${Date.now()}`);
  contacts.push(visitor.contactId);
  return visitor;
}

const isWelcome = (m: { content: string | null }) => m.content === MESSAGES.welcome;

describe("ウィジェットを開いたときの一覧（開発の Chatwoot）", () => {
  describe("正常系", () => {
    it("会話の無い訪問者が開くと、ボットが pending の会話を作り、トップページの FAQ を順に出す", async () => {
      const visitor = await newVisitor();
      await visitor.open();
      const welcome = await botMessage(visitor, isWelcome, "一覧");
      expect(welcome.content_type).toBe("input_select");
      expect(welcome.content_attributes?.items).toEqual([
        { title: "ソースコードは本当に無料ですか？", value: "top-1" },
        { title: "料金は税込ですか？", value: "top-3" },
      ]);
      expect(await admin.conversation(welcome.conversation_id)).toEqual({ status: "pending", labels: [] });
    });

    it("一覧の項目を選ぶと、その FAQ の原文で答え、faq-answered を付ける", async () => {
      const visitor = await newVisitor();
      await visitor.open();
      const welcome = await botMessage(visitor, isWelcome, "一覧");
      await visitor.select(welcome.id, { title: "料金は税込ですか？", value: "top-3" });
      const answer = await botMessage(visitor, (m) => (m.content ?? "").startsWith("表示価格はすべて税別です。"), "選んだ FAQ の回答");
      expect(answer.conversation_id).toBe(welcome.conversation_id);
      const labeled = await waitFor(async () => {
        const c = await admin.conversation(welcome.conversation_id);
        return c.labels.length > 0 ? c : null;
      }, "ラベルが付く");
      expect(labeled).toEqual({ status: "pending", labels: ["faq-answered"] });
    });

    it("直前の会話が解決済みなら、開いたときに新しい会話で一覧を出す", async () => {
      const visitor = await newVisitor();
      const { conversation_id: first } = await visitor.say("料金は税込ですか？");
      const reply = await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      await visitor.select(reply.id, { title: "解決しました", value: "__resolved" });
      await waitFor(async () => (await admin.conversation(first)).status === "resolved", "会話が resolved になる");
      await visitor.open();
      const welcome = await botMessage(visitor, isWelcome, "新しい会話の一覧");
      expect(welcome.conversation_id).not.toBe(first);
    });
  });

  describe("異常系", () => {
    it("入力: 進行中の会話がある訪問者が開いても、新しい会話も一覧も作らない", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      await visitor.open();
      // 何も起きないことを確かめるため、Webhook が処理されるだけの時間を待つ
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const messages = await visitor.messages();
      expect(messages.every((m) => m.conversation_id === conversation_id)).toBe(true);
      expect(messages.some(isWelcome)).toBe(false);
    });
  });
});
