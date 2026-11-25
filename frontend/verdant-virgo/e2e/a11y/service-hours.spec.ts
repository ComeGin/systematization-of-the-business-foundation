// 受付時間外（0〜8 時 JST。2026-11-25 のユーザーの決定。src/modules/service-hours）の検査。
// 本番の Chatwoot・Mautic は 0 時〜7 時 50 分に止まるので、公開サイトはこの時間にフォームの送信とチャットの読み込みをしない。
// 共通の fixture は受付時間外に実行すると時計を日中にずらす（support/service-hours.ts）ので、ここでは各テストの中で時計を設定し直す。
// 文言の正本は 01-content-spec.md の §5.1（受付時間外）と §8.4。
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  CONSULT_TEXT,
  consultForm,
  emailField,
  fillConsult,
} from "../support/forms";
import { liveRegionTexts } from "../support/dom";
import { jstToday } from "../support/service-hours";
import { audit, brief, open } from "./axe";
import { CHAT_CLOSED_NOTICE } from "../../src/modules/chat/lib/messages";

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Chatwoot の SDK への要求を数える（読み込まないことを確かめる。SDK は fixture が止めるが、要求そのものを数える） */
function countSdkRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/packs/js/sdk.js") count += 1;
  });
  return () => count;
}

test.describe("受付時間外（0〜8 時）", () => {
  test.describe("正常系", () => {
    test("02:00 は送信ボタンの上に受付時間外の案内を出してボタンを押せなくし、違反が無い", async ({
      page,
      net,
    }, testInfo) => {
      const { result } = await audit(
        page,
        testInfo,
        "/contact/",
        "service-closed",
        async () => {
          await page.clock.setSystemTime(jstToday("02:00"));
          const response = await open(page, "/contact/");
          return response;
        },
      );
      expect(brief(result.violation_items)).toEqual([]);
      const form = await consultForm(page);
      const submit = form.getByRole("button", { name: CONSULT_TEXT.submit });
      await expect(submit).toBeDisabled();
      await expect(
        form.getByRole("group", { name: CONSULT_TEXT.closedTitle }),
      ).toContainText(CONSULT_TEXT.closedBody);
      // 押せない理由をボタンの説明として読ませる（無効のボタンには Tab で止まらないので、案内は role=status でも 1 回読む）
      await expect(submit).toHaveAccessibleDescription(
        new RegExp(`^${escapeRegExp(CONSULT_TEXT.closedBody)}`),
      );
      await expect
        .poll(() => liveRegionTexts(page))
        .toContainEqual(expect.stringContaining(CONSULT_TEXT.closedTitle));
      // 案内はボタンのすぐ上（ボタンの近くで理由が分かる。フォームの上に置かない）
      const alertBox = await form
        .getByRole("group", { name: CONSULT_TEXT.closedTitle })
        .boundingBox();
      const submitBox = await submit.boundingBox();
      expect(alertBox && submitBox && alertBox.y < submitBox.y).toBe(true);
      expect(net.to("/form/submit")).toHaveLength(0);
    });

    test("07:59 に開いたページは、8 時を過ぎると 1 分以内に送信ボタンが押せるようになり、案内が消える", async ({
      page,
    }) => {
      await page.clock.install({ time: jstToday("07:59:30") });
      await open(page, "/contact/");
      const form = await consultForm(page);
      const submit = form.getByRole("button", { name: CONSULT_TEXT.submit });
      await expect(submit).toBeDisabled();
      await page.clock.runFor(61_000);
      await expect(submit).toBeEnabled();
      await expect(
        form.getByRole("group", { name: CONSULT_TEXT.closedTitle }),
      ).toHaveCount(0);
    });

    test("02:00 に同意してもチャットの SDK を読み込まず、「チャットで質問する」を押すと受付時間外の案内を出す", async ({
      page,
    }) => {
      await page.clock.setSystemTime(jstToday("02:00"));
      const sdkRequests = countSdkRequests(page);
      await open(page, "/contact/");
      await page.getByRole("button", { name: "同意する" }).click();
      await page.getByRole("button", { name: "チャットで質問する" }).click();
      await expect(page.locator("#chat-open-failure")).toHaveText(
        CHAT_CLOSED_NOTICE,
      );
      await expect(page.locator("#chat-open-failure")).toHaveAttribute(
        "role",
        "status",
      );
      await expect(page.locator("#chat-open-failure a")).toHaveAttribute(
        "href",
        "mailto:kamegin4@comegin.com",
      );
      expect(sdkRequests()).toBe(0);
    });
  });

  test.describe("異常系", () => {
    test("入力: 02:00 に全項目を入れてメールアドレスの欄で Enter を押しても送られない", async ({
      page,
      net,
    }) => {
      await page.clock.setSystemTime(jstToday("02:00"));
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form);
      await emailField(form).press("Enter");
      await expect(
        form.getByRole("group", { name: CONSULT_TEXT.closedTitle }),
      ).toBeVisible();
      expect(net.to("/form/submit")).toHaveLength(0);
      await expect(page).toHaveURL(/\/contact\/?$/);
    });

    test("入力: 23:59 に開いて 0 時を過ぎてから送信しても送らず、受付時間外の案内にフォーカスを移す", async ({
      page,
      net,
    }) => {
      await page.clock.install({ time: jstToday("23:59:50") });
      await open(page, "/contact/");
      const form = await consultForm(page);
      await fillConsult(form);
      const submit = form.getByRole("button", { name: CONSULT_TEXT.submit });
      await expect(submit).toBeEnabled();
      // 1 分ごとの更新より前に 0 時を越える（送信の直前の判定で止まることを確かめる）
      await page.clock.setSystemTime(jstToday("23:59:50").getTime() + 20_000);
      await submit.click();
      const notice = form.getByRole("group", {
        name: CONSULT_TEXT.closedTitle,
      });
      await expect(notice).toBeFocused();
      expect(net.to("/form/submit")).toHaveLength(0);
    });
  });
});
