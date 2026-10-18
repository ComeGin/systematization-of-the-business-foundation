// モーションの検査のうち、WebGL を無効にして起動するもの（計画書の検証 9 の「WebGL なし」。動きの規則 5「段階的に強化する」）。
// 起動の引数は worker ごとに決まるため、motion.spec.ts から分けてファイルの最上位で test.use する。
import { expect, test } from "../support/fixtures";
import { open } from "./axe";

const GALLERY_ROUTE = "/services/partnership/";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-3d-apis"] } });

/** CTA バナーの中の MotionBlobs（トップの 1-11）を画面に入れる */
async function showBlobs(page: import("@playwright/test").Page) {
  const blobs = page.locator('[data-motion="blobs"]').first();
  await blobs.scrollIntoViewIfNeeded();
  await expect(blobs).toBeAttached();
  return blobs;
}

test.describe("モーション（WebGL なし）", () => {
  test.describe("異常系", () => {
    test("入力: WebGL が無くても、静止の SVG・img・リンクで内容が欠けず、コンソールにエラーが出ない", async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await open(page, "/");
      if (testInfo.project.name === "desktop") {
        await expect(
          page.locator(
            '[data-motion="symbol"] img[src*="comegin-symbol-navy"]',
          ),
        ).toBeVisible();
        await expect(
          page
            .locator('[data-motion="nav"] nav ul:not([aria-hidden]) a')
            .first(),
        ).toBeVisible();
        const blobs = await showBlobs(page);
        await expect(blobs.locator("svg")).toBeVisible();
      }
      await open(page, GALLERY_ROUTE);
      await expect(
        page.locator('[data-motion="gallery"] [data-slide="0"] img'),
      ).toBeVisible();
      await page
        .locator('[data-motion="gallery"]')
        .getByRole("radio")
        .nth(1)
        .check();
      await expect(
        page.locator('[data-motion="gallery"] [data-slide="1"] img'),
      ).toBeVisible();
      // 開発の受け口に届かない（同意前の Chatwoot・consent-api など）ことによるネットワークの失敗は除く
      expect(
        errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)),
      ).toEqual([]);
    });
  });
});
