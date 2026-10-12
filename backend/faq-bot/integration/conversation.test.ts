import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const statusIs = (conversationId: number, status: string) =>
  waitFor(async () => {
    const c = await admin.conversation(conversationId);
    return c.status === status ? c : null;
  }, `会話が ${status} になる`);

const labeled = (conversationId: number) =>
  waitFor(async () => {
    const c = await admin.conversation(conversationId);
    return c.labels.length > 0 ? c : null;
  }, "ラベルが付く");

describe("FAQ ボット（開発の Chatwoot）", () => {
  describe("正常系", () => {
    it("FAQ にある質問に原文で答え、faq-answered を付け、pending のままにする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      const reply = await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      expect(reply.content).toBe("表示価格はすべて税別です。\n\n詳しくは: http://localhost:4321/#top-faq");
      expect(reply.content_attributes?.items?.map((i) => i.value)).toEqual(["__resolved", "__handoff"]);
      // ラベルは返信の後に付くので待つ
      expect(await labeled(conversation_id)).toEqual({ status: "pending", labels: ["faq-answered"] });
    });

    it("［解決しました］で会話を resolved にする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      const reply = await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      await visitor.select(reply.id, { title: "解決しました", value: "__resolved" });
      await statusIs(conversation_id, "resolved");
      await botMessage(visitor, (m) => (m.content ?? "").startsWith("お役に立ててよかったです"), "お礼");
    });

    it("同じ質問が並んだら context つきの候補を出し、選んだ FAQ で答える", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("契約の期間と解約を教えてください");
      const prompt = await botMessage(visitor, (m) => m.content === "次のどれに近いですか？", "候補");
      expect(prompt.content_attributes?.items?.map((i) => i.title)).toEqual([
        "契約の期間と解約を教えてください（コンサル）",
        "契約の期間と解約を教えてください（業務提携）",
        "どれにも当てはまらない",
      ]);
      await visitor.select(prompt.id, prompt.content_attributes!.items![0]!);
      await botMessage(visitor, (m) => (m.content ?? "").startsWith("コンサルの契約期間は"), "選んだ FAQ の回答");
      expect((await labeled(conversation_id)).labels).toEqual(["faq-answered"]);
    });

    it("［どれにも当てはまらない］で faq-unmatched を付けて open にする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("契約の期間と解約を教えてください");
      const prompt = await botMessage(visitor, (m) => m.content === "次のどれに近いですか？", "候補");
      await visitor.select(prompt.id, { title: "どれにも当てはまらない", value: "__none" });
      expect(await statusIs(conversation_id, "open")).toEqual({ status: "open", labels: ["faq-unmatched"] });
      await botMessage(visitor, (m) => (m.content ?? "").startsWith("担当者におつなぎします"), "引き継ぎの案内");
    });

    it("［担当者に相談する］で faq-handoff を付けて open にする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      const reply = await botMessage(visitor, (m) => m.content_type === "input_select", "回答");
      await visitor.select(reply.id, { title: "担当者に相談する", value: "__handoff" });
      const c = await statusIs(conversation_id, "open");
      expect(c.labels.sort()).toEqual(["faq-answered", "faq-handoff"]);
    });
  });

  describe("異常系", () => {
    it("入力: 次の質問に答えた後で、前の回答の［解決しました］を押しても何もしない", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("料金は税込ですか？");
      const first = await botMessage(visitor, (m) => m.content_type === "input_select", "1 つ目の回答");
      await visitor.say("契約の期間と解約を教えてください");
      await botMessage(visitor, (m) => m.content === "次のどれに近いですか？", "2 つ目の候補");
      await visitor.select(first.id, { title: "解決しました", value: "__resolved" });
      // 何も起きないことを確かめるため、Webhook が処理されるだけの時間を待つ
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect((await admin.conversation(conversation_id)).status).toBe("pending");
      expect((await visitor.messages()).some((m) => (m.content ?? "").startsWith("お役に立ててよかったです"))).toBe(false);
    });

    it("入力: FAQ に無い質問は faq-unmatched で open にする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("営業時間は何時までですか");
      expect(await statusIs(conversation_id, "open")).toEqual({ status: "open", labels: ["faq-unmatched"] });
    });

    it("空入力: 記号だけの発言も落ちずに faq-unmatched で open にする", async () => {
      const visitor = await newVisitor();
      const { conversation_id } = await visitor.say("？？？");
      expect(await statusIs(conversation_id, "open")).toEqual({ status: "open", labels: ["faq-unmatched"] });
    });
  });
});
