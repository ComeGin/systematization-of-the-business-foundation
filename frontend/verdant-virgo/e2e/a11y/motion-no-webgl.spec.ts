// モーションの検査のうち、WebGL を無効にして起動するもの（計画書の検証 9 の「WebGL なし」。動きの規則 5「段階的に強化する」）。
// 起動の引数は worker ごとに決まるため、motion.spec.ts から分けてファイルの最上位で test.use する。
import { expect, test } from "../support/fixtures";
import { open } from "./axe";
import {
  AVATAR_LABELS,
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
        await expect(
          page.locator(
            '[data-motion="symbol"] img[src*="comegin-symbol-"]',
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
        await globe.evaluate(
          (el) => Number(getComputedStyle(el.querySelector(".globe-osaka__still")!).opacity),
        ),
      ).toBe(1);
      expect(rendererScripts, "three を読んでいない").toBe(0);
      expect(
        errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)),
      ).toEqual([]);
    });
  });

  test.describe("異常系（アバター）", () => {
    // 既定の fixture はアバターを止めて開くので、ここだけ動かして開く（avatar.spec.ts と同じ）
    test.use({ avatarLive: true });

    test("入力: WebGL が無いと、アバターは静止画のまま（一時停止のボタンなし・.vrm を要求しない）で、コンソールにエラーが出ない", async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "Desktop（最初から 3D を出す端末）だけ");
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const models: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith(".vrm")) models.push(request.url());
      });
      await open(page, "/");
      const dock = page.locator('[data-motion="avatar"]');
      // canUseWebGL() が false なので、three を取りに行く前に failed になる
      await expect(dock).toHaveAttribute("data-avatar-state", "failed", { timeout: 10_000 });
      await expect(dock.locator("img.avatar-dock__still")).toBeVisible();
      await expect(dock.locator("canvas")).toHaveCount(0);
      await expect(
        dock.getByRole("button", {
          name: new RegExp(`^(${AVATAR_LABELS.pause}|${AVATAR_LABELS.resume})\\s*${MOTION_PAUSE_TARGETS.avatar}$`),
        }),
      ).toHaveCount(0);
      await page.waitForTimeout(1_000);
      expect(models, ".vrm を要求しない").toEqual([]);
      expect(
        errors.filter((e) => !/Failed to load resource|net::ERR_/.test(e)),
      ).toEqual([]);
    });
  });
});
