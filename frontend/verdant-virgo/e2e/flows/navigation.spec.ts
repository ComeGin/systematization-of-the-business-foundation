// 公開サイトの回遊（ヘッダーのナビ・無料相談のボタン・存在しない URL）。
// 文言とリンクは src の site-content から読む（文言を変えてもテストが追従する）。
import { expect, test } from "./support/fixtures";
import { headerCta, headerNav } from "../../src/modules/site-content/nav";
import { notFound } from "../../src/modules/site-content/system";

test.describe("公開サイトの回遊", () => {
  test.describe("正常系", () => {
    for (const item of headerNav) {
      test(`ヘッダーの「${item.label}」で ${item.href} に移り、ページの h1 が出る`, async ({
        page,
      }) => {
        await page.goto("/");
        await page
          .getByRole("banner")
          .getByRole("link", { name: item.label, exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp(`${item.href}/?$`));
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      });
    }

    test("ヘッダーの「無料相談」は、今いるページを from に付けて無料相談のフォームへ移る", async ({
      page,
    }) => {
      await page.goto("/pricing/");
      await page
        .getByRole("banner")
        .getByTestId(headerCta.desktopCtaId)
        .click();
      await expect(page).toHaveURL(/\/contact\/?\?/);
      const url = new URL(page.url());
      expect(url.searchParams.get("cta")).toBe(headerCta.desktopCtaId);
      expect(url.searchParams.get("from")).toMatch(/^\/pricing\/?$/);
    });
  });

  test.describe("異常系", () => {
    test("入力: 存在しない URL は 404 を返し、404 のページからトップへ戻れる", async ({
      page,
    }) => {
      const response = await page.goto(`/${test.info().testId}-not-found/`);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole("heading", { level: 1, name: notFound.h1 }),
      ).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex/,
      );

      const back = notFound.buttons.find((button) => button.href === "/")!;
      await page
        .getByRole("main")
        .getByRole("link", { name: back.label })
        .click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  });
});
