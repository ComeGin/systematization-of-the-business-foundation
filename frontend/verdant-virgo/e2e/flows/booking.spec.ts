// 完了画面の予約枠（I-25 ブラウザ → Cal.com。SaaS でオンプレの外なので、embed.js を偽物に差し替える。support/calcom-stub.ts）。
// 予約枠は同意の対象にしない（同意していない訪問者にも出す）が、booking_* のイベントは同意の後にだけ PostHog に送る（DD-02 の 7.4）。
// 失敗したら代わりの案内を必ず出す（7.3。行き止まりを作らない）。
import type { Page } from "@playwright/test";
import { expect, grantConsent, test } from "./support/fixtures";
import { FAKE_SLOT_LABEL } from "./support/calcom-stub";
import { BOOKING_TEXT } from "../../src/modules/booking/lib/messages";
import { contactThanks } from "../../src/modules/site-content/contact";

// 状態は予約枠の根の data-booking-state に出る（BookingFrame.tsx。e2e が見るための約束）
const bookingState = (page: Page) => page.locator("[data-booking-state]");

test.describe("完了画面の予約枠", () => {
  test.describe("正常系", () => {
    test("予約枠が読み込まれると、iframe の名前を見出しと同じ日本語にし、代わりの案内は出さない", async ({
      page,
    }) => {
      await page.goto("/contact/thanks/");
      await expect(bookingState(page)).toHaveAttribute(
        "data-booking-state",
        "ready",
      );
      const frame = bookingState(page).locator("iframe");
      await expect(frame).toHaveAttribute(
        "title",
        contactThanks.booking.heading,
      );
      await expect(
        page
          .frameLocator("[data-booking-state] iframe")
          .getByRole("button", { name: FAKE_SLOT_LABEL }),
      ).toBeVisible();
      await expect(page.getByText(BOOKING_TEXT.failedTitle)).toHaveCount(0);
    });

    test.describe("PostHog に届くイベント", () => {
      test.use({ looksHuman: true });

      test("Cookie に同意した訪問者が予約を終えると、booking_viewed と booking_scheduled を PostHog に送る", async ({
        page,
        traffic,
        cleanup,
      }) => {
        await page.goto("/");
        await grantConsent(page, cleanup);
        await expect.poll(() => traffic.posthogRequests).toBeGreaterThan(0);

        await page.goto("/contact/thanks/");
        await expect(bookingState(page)).toHaveAttribute(
          "data-booking-state",
          "ready",
        );
        await bookingState(page).scrollIntoViewIfNeeded();
        await expect
          .poll(() => traffic.posthogEvents, {
            message: `PostHog への要求: ${traffic.posthogLog.join(" | ")}`,
          })
          .toContain("booking_viewed");

        await page.evaluate(() =>
          (
            window as unknown as { __e2eCal: { emit(type: string): void } }
          ).__e2eCal.emit("bookingSuccessfulV2"),
        );
        await expect
          .poll(() => traffic.posthogEvents)
          .toContain("booking_scheduled");
      });
    });

    test("同意していない訪問者にも予約枠を出すが、PostHog には何も送らない", async ({
      page,
      traffic,
    }) => {
      await page.goto("/contact/thanks/");
      await expect(bookingState(page)).toHaveAttribute(
        "data-booking-state",
        "ready",
      );
      await bookingState(page).scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        (
          window as unknown as { __e2eCal: { emit(type: string): void } }
        ).__e2eCal.emit("bookingSuccessfulV2"),
      );
      await page.waitForLoadState("networkidle");
      expect(traffic.posthogRequests).toBe(0);
    });
  });

  test.describe("異常系", () => {
    test.describe("embed.js に届かない", () => {
      test.use({ calcom: "fail" });

      test("サーバ: 予約枠の読み込みに失敗すると、メールで日程を調整する代わりの案内を出す", async ({
        page,
      }) => {
        await page.goto("/contact/thanks/");
        await expect(bookingState(page)).toHaveAttribute(
          "data-booking-state",
          "failed",
        );
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: BOOKING_TEXT.failedTitle }),
        ).toContainText(BOOKING_TEXT.failedBody);
        // 完了画面そのものは壊れない（CV は予約より前に成立している）
        await expect(
          page.getByRole("heading", { level: 1, name: contactThanks.hero.h1 }),
        ).toBeVisible();
      });
    });

    test.describe("embed.js は読めたが、枠から何の通知も来ない", () => {
      test.use({ calcom: "silent" });

      test("サーバ: 15 秒たっても通知が来なければ、代わりの案内に切り替える", async ({
        page,
      }) => {
        await page.clock.install();
        // 15 秒のタイマーは island の水和の後（useEffect）で作られ、同じ処理で embed.js を読みに行く。読みに来てから時計を進める
        const embedRequested = page.waitForRequest((r) =>
          r.url().endsWith("/embed/embed.js"),
        );
        await page.goto("/contact/thanks/");
        await embedRequested;
        await expect(bookingState(page)).toHaveAttribute(
          "data-booking-state",
          "loading",
        );
        await page.clock.runFor(15_000);
        await expect(bookingState(page)).toHaveAttribute(
          "data-booking-state",
          "failed",
        );
        await expect(page.getByText(BOOKING_TEXT.failedTitle)).toBeVisible();
      });
    });
  });
});
