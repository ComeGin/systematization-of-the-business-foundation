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

/** FAQ に無い質問で担当者に引き継がせ、open の会話にする */
async function handedOff(visitor: Visitor): Promise<number> {
  const { conversation_id } = await visitor.say("営業時間は何時までですか");
  await waitFor(async () => (await admin.conversation(conversation_id)).status === "open", "引き継いで open になる");
  return conversation_id;
}

const isAsk = (m: { content: string | null }) => m.content === MESSAGES.askResolved;

describe("担当者のマクロ「解決の確認を送る」（開発の Chatwoot）", () => {
  describe("正常系", () => {
    it("open の会話にラベル faq-ask-resolved を付けると、ボットがラベルを外して［解決しました］ボタンを送る", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.reply(id, "営業時間は平日 9 時から 18 時です。");
      const before = await admin.conversation(id);
      await admin.setLabels(id, [...before.labels, "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      expect(ask.content_attributes?.items).toEqual([{ title: "解決しました", value: "__resolved" }]);
      const after = await waitFor(async () => {
        const c = await admin.conversation(id);
        return c.labels.includes("faq-ask-resolved") ? null : c;
      }, "ラベルが外れる");
      expect(after).toEqual({ status: "open", labels: ["faq-unmatched"] });
    });

    it("訪問者がそのボタンの［解決しました］を押すと、お礼を返して resolved にする（open の会話でも）", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.setLabels(id, ["faq-unmatched", "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      await visitor.select(ask.id, { title: "解決しました", value: "__resolved" });
      await waitFor(async () => (await admin.conversation(id)).status === "resolved", "resolved になる");
      await botMessage(visitor, (m) => (m.content ?? "").startsWith("お役に立ててよかったです"), "お礼");
    });

    // 2026-10-12: スヌーズ中も担当者の会話として、ボタンが最新なら閉じる
    it("スヌーズ中の会話でも、ボタンの［解決しました］を押すと resolved にする", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.setStatus(id, "snoozed");
      await waitFor(async () => (await admin.conversation(id)).status === "snoozed", "snoozed になる");
      await admin.setLabels(id, ["faq-unmatched", "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      await visitor.select(ask.id, { title: "解決しました", value: "__resolved" });
      await waitFor(async () => (await admin.conversation(id)).status === "resolved", "resolved になる");
    });
  });

  describe("異常系", () => {
    // 2026-10-12 のユーザーの決定: 「今ラベルが付いたとき」だけ。残ったラベルで、開き直しなどの別の更新のときにボタンを出さない
    it("入力: 解決済みの会話に付けたラベルは何もせず残り、会話を開き直してもボタンを出さない", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.setStatus(id, "resolved");
      await admin.setLabels(id, ["faq-unmatched", "faq-ask-resolved"]);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await admin.setStatus(id, "open");
      // 何も起きないことを確かめるため、Webhook が処理されるだけの時間を待つ
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect((await visitor.messages()).some(isAsk)).toBe(false);
      const after = await admin.conversation(id);
      expect(after.status).toBe("open");
      expect([...after.labels].sort()).toEqual(["faq-ask-resolved", "faq-unmatched"]);
    });

    it("入力: ボタンの後に担当者が返信してから押しても、何もしない（open のまま）", async () => {
      const visitor = await newVisitor();
      const id = await handedOff(visitor);
      await admin.setLabels(id, ["faq-unmatched", "faq-ask-resolved"]);
      const ask = await botMessage(visitor, isAsk, "解決の確認のボタン");
      await admin.reply(id, "追加でご案内です。");
      await visitor.select(ask.id, { title: "解決しました", value: "__resolved" });
      // 何も起きないことを確かめるため、Webhook が処理されるだけの時間を待つ
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect((await admin.conversation(id)).status).toBe("open");
      expect((await visitor.messages()).some((m) => (m.content ?? "").startsWith("お役に立ててよかったです"))).toBe(false);
    });
  });
});
