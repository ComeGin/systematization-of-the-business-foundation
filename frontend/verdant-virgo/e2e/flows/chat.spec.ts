// チャット（I-07 ブラウザ → Chatwoot、I-31〜I-33 Chatwoot ⇄ faq-bot）。同意した訪問者がウィジェットを開き、
// 本物の開発の Chatwoot と FAQ ボットが FAQ の原文で答える（当たらなければ担当者に引き継ぐ）までを通す。
// a11y の chat.spec.ts はウィジェットの名前とフォーカスを見る。ここは会話が Chatwoot にどう残るか（ラベル・ステータス）を見る。
// 質問と答えはテストに書かず、E2E の dev サーバーの /faq.json（ボットが読むのと同じ形）から読む。
// ウィジェットが作った会話とコンタクトは、テストの終わりに消す（cw_conversation の JWT から会話の番号を引く）。
import type { FrameLocator, Page } from "@playwright/test";
import { expect, grantConsent, test, type Cleanup } from "./support/fixtures";
import {
  chatwootConversation,
  deleteChatwootConversation,
  eventually,
  widgetConversationId,
} from "./support/devstack";
import { devValue, e2eName } from "./support/env";
import { CHAT_WIDGET_NAMES } from "../../src/modules/chat/lib/messages";
import { MESSAGES } from "../../../../backend/faq-bot/src/constants";

interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

/** 同意してウィジェットを開き、会話の後片付けを積む。ウィジェットの中（iframe）を返す */
async function openWidget(page: Page, cleanup: Cleanup): Promise<FrameLocator> {
  await page.goto("/");
  await grantConsent(page, cleanup);
  await page.getByRole("button", { name: CHAT_WIDGET_NAMES.launcher }).click();
  const widget = page.frameLocator(
    `iframe[title="${CHAT_WIDGET_NAMES.frame}"]`,
  );

  // 開くとボットが会話を作り、FAQ の一覧を送る（webwidget_triggered。faq-bot の executeWelcome）。
  // 初めて開いたときはホーム画面のままなので、一覧が届いたら「会話を続行」で会話の画面へ移る
  cleanup.add("Chatwoot の会話とコンタクト", async () => {
    const jwt = (await page.context().cookies()).find(
      (c) => c.name === "cw_conversation",
    )?.value;
    if (!jwt) return;
    const id = await widgetConversationId(
      devValue("CHATWOOT_WEBSITE_TOKEN"),
      jwt,
    );
    // ウィジェットが開いている間（訪問者の接続が残っている間）は、コンタクトを消せない（422）。先にページを閉じる
    await page.close();
    if (id) await deleteChatwootConversation(id);
  });
  await widget.getByRole("button", { name: /会話を(続行|開始)/ }).click();
  await expect(widget.getByText(MESSAGES.welcome)).toBeVisible({
    timeout: 60_000,
  });
  return widget;
}

async function ask(widget: FrameLocator, text: string) {
  const input = widget.getByRole("textbox").last();
  await input.fill(text);
  await input.press("Enter");
}

/** この訪問者の会話（Chatwoot の管理 API で読む） */
async function conversationOf(page: Page) {
  const jwt = await eventually(
    "ウィジェットの cw_conversation",
    async () =>
      (await page.context().cookies()).find((c) => c.name === "cw_conversation")
        ?.value,
  );
  const id = await eventually("ウィジェットの会話", () =>
    widgetConversationId(devValue("CHATWOOT_WEBSITE_TOKEN"), jwt),
  );
  return { id, read: () => chatwootConversation(id) };
}

test.describe("チャット（FAQ ボット）", () => {
  // ボットの返事は Webhook → faq-bot → Chatwoot → WebSocket の往復になる
  // 3 本とも同じ受信箱とボットを使う。同時に流すと開発の Chatwoot（1 つの Rails と sidekiq）の処理が詰まり、
  // ウィジェットやボットの返事が来なくなった（2026-10-25）。ファイルの中は 1 つのワーカーで順に流す（失敗しても後のテストは流す）
  test.describe.configure({ mode: "default", timeout: 180_000 });

  let faq: FaqItem[];
  test.beforeAll(async ({ request }) => {
    const res = await request.get("/faq.json");
    expect(res.ok()).toBeTruthy();
    faq = ((await res.json()) as { items: FaqItem[] }).items;
    expect(faq.length).toBeGreaterThan(0);
  });

  test.describe("正常系", () => {
    test("ウィジェットを開くとボットが FAQ の一覧を送り、FAQ の質問には原文で答えて faq-answered のラベルを付ける", async ({
      page,
      cleanup,
    }) => {
      const widget = await openWidget(page, cleanup);
      // 一覧はトップページの FAQ（id が top- で始まる）
      const top = faq.filter((item) => item.id.startsWith("top-"));
      await expect(widget.getByText(top[0].question).first()).toBeVisible();

      // 一番短い答えの FAQ を、質問の原文で聞く（はっきり当たる）
      const target = [...top].sort(
        (a, b) => a.answer.length - b.answer.length,
      )[0];
      await ask(widget, target.question);
      await expect(widget.getByText(target.answer)).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        widget.getByRole("button", { name: MESSAGES.choiceResolved }),
      ).toBeVisible();

      const conversation = await conversationOf(page);
      await expect
        .poll(async () => (await conversation.read()).labels, {
          timeout: 60_000,
        })
        .toContain("faq-answered");
      // 答えられたので担当者には回さない（pending のまま）
      expect((await conversation.read()).status).toBe("pending");
    });

    test("［解決しました］を押すと、ボットがお礼を返し、会話を解決済みにする", async ({
      page,
      cleanup,
    }) => {
      const widget = await openWidget(page, cleanup);
      const target = faq.filter((item) => item.id.startsWith("top-"))[0];
      await ask(widget, target.question);
      await widget
        .getByRole("button", { name: MESSAGES.choiceResolved })
        .click();
      await expect(widget.getByText(MESSAGES.resolved)).toBeVisible({
        timeout: 60_000,
      });

      const conversation = await conversationOf(page);
      await expect
        .poll(async () => (await conversation.read()).status, {
          timeout: 60_000,
        })
        .toBe("resolved");
    });
  });

  test.describe("異常系", () => {
    test("入力: FAQ に当たらない質問は、担当者への引き継ぎを案内し、faq-unmatched を付けて open にする", async ({
      page,
      cleanup,
    }) => {
      const widget = await openWidget(page, cleanup);
      await ask(
        widget,
        `${e2eMarker()} 来月の天気と、御社の駐車場の台数を知りたい`,
      );
      await expect(widget.getByText(MESSAGES.handoff)).toBeVisible({
        timeout: 60_000,
      });

      const conversation = await conversationOf(page);
      await expect
        .poll(async () => (await conversation.read()).labels, {
          timeout: 60_000,
        })
        .toContain("faq-unmatched");
      expect((await conversation.read()).status).toBe("open");
    });
  });
});

/** 質問の先頭に付ける印（Chatwoot の管理画面で E2E の会話だと分かるように） */
function e2eMarker() {
  return `[${e2eName("chat")}]`;
}
