// モーションの検査のうち、WebGL を無効にして起動するもの（計画書の検証 9 の「WebGL なし」。動きの規則 5「段階的に強化する」）。
// 起動の引数は worker ごとに決まるため、motion.spec.ts から分けてファイルの最上位で test.use する。
import { expect, test } from "../support/fixtures";
import { open } from "./axe";
import {
  MOTION_PAUSE_TARGETS,
} from "../../src/modules/site-content/a11y";

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
        // 2026-10-29: ヒーローはアトリエ（第 2 版）。WebGL が無いときはアトリエのポスター
        await expect(page.locator('[data-motion="atelier"] picture img')).toBeVisible();
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

  test.describe("異常系（地球儀）", () => {
    test("入力: WebGL が無いと、サービス一覧の地球儀は静止画のまま（canvas なし・一時停止のボタンなし・three を読まない）で、コンソールにエラーが出ない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "md 以上だけで動かす部品");
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      let rendererScripts = 0;
      page.on("response", async (response) => {
        if (!/\.js(\?|$)/.test(response.url()) || !response.ok()) return;
        const body = await response.text().catch(() => "");
        if (body.includes("WebGLRenderer")) rendererScripts++;
      });
      await open(page, "/services/");
      await page.waitForTimeout(4_000);
      const globe = page.locator("#globe-osaka");
      await expect(globe.locator("canvas")).toHaveCount(0);
      await expect(globe.getByRole("button")).toHaveCount(0);
      await expect(globe.locator(".globe-osaka__land")).toBeVisible();
      expect(
        await globe.evaluate((el) =>
          Number(
            getComputedStyle(el.querySelector(".globe-osaka__still")!).opacity,
          ),
        ),
      ).toBe(1);
      expect(rendererScripts, "three を読んでいない").toBe(0);
      expect(
        errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)),
      ).toEqual([]);
    });
  });

  test.describe("異常系（ヒーローのアトリエ）", () => {
    test("入力: WebGL が無いと、アトリエはポスターのまま（canvas なし・一時停止のボタンなし）で、コンソールにエラーが出ない", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.addInitScript(() => {
        try {
          sessionStorage.setItem(
            "atelier:quality",
            JSON.stringify({ live: true, dpr: 1 }),
          );
        } catch {}
      });
      await open(page, "/");
      await page.waitForTimeout(4_000);
      const root = page.locator('[data-motion="atelier"]');
      await expect(root.locator("picture img")).toBeVisible();
      await expect(root.locator("canvas")).toHaveCount(0);
      await expect(
        root.getByRole("button", { name: /動きを止める|動きを再開する/ }),
      ).toHaveCount(0);
      expect(
        errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)),
      ).toEqual([]);
    });
  });
});
