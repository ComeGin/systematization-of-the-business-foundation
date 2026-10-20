// チャット（Chatwoot のウィジェット）に補った名前の検査（integrations の chat/lib/widget-a11y.ts。G-2 の判断）。
// Chatwoot の更新で黙って崩れないよう、同意した後のウィジェットのページ側の名前とフォーカスを見る。
// ウィジェットの中（iframe の中）は部分適合の対象（P-7）なので見ない。consent-api の /v1/consent はパスで差し替える。
// 開発の Chatwoot（ビルドに焼き込まれた PUBLIC_CHATWOOT_BASE。ngrok 経由で 127.0.0.1:3100）に届かないときは skip する。
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { open } from "./axe";
import { CHAT_WIDGET_NAMES } from "../../src/modules/chat/lib/messages";

test.use({ allowChat: true });

/** 同意して SDK を読ませ、ランチャーが出るまで待つ。SDK に届かなければ skip */
async function consentAndWaitForWidget(page: Page) {
  await open(page, "/");
  const sdk = page
    .waitForResponse((r) => new URL(r.url()).pathname === "/packs/js/sdk.js", { timeout: 20_000 })
    .catch(() => null);
  await page.getByRole("button", { name: "同意する" }).click();
  const response = await sdk;
  test.skip(!response?.ok(), "開発の Chatwoot の SDK に届かない（Chatwoot か ngrok が止まっている）");
  await page.locator(".woot-widget-bubble:not(.woot--close)").waitFor({ state: "attached", timeout: 20_000 });
}

test.describe("チャットのウィジェット", () => {
  test.describe("正常系", () => {
    test("同意した後、ランチャー・閉じるボタン・iframe に日本語の名前があり、要素の見落としの警告が出ない", async ({ page, net }) => {
      test.setTimeout(60_000);
      const warnings: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "warning" && m.text().includes("[chat]")) warnings.push(m.text());
      });
      await consentAndWaitForWidget(page);
      expect(net.to("/v1/consent")).toHaveLength(1);
      await expect(page.locator(".woot-widget-bubble:not(.woot--close)")).toHaveAttribute("aria-label", CHAT_WIDGET_NAMES.launcher);
      await expect(page.locator(".woot-widget-bubble.woot--close")).toHaveAttribute("aria-label", CHAT_WIDGET_NAMES.close);
      await expect(page.locator("#chatwoot_live_chat_widget")).toHaveAttribute("title", CHAT_WIDGET_NAMES.frame);
      expect(warnings).toEqual([]);
    });

    test("ランチャーで Enter を押すとウィジェットにフォーカスが移り、閉じるとランチャーに戻る（Mobile は SDK の toggle で閉じる）", async ({ page }) => {
      test.setTimeout(60_000);
      await consentAndWaitForWidget(page);
      const launcher = page.locator(".woot-widget-bubble:not(.woot--close)");
      await launcher.focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 10_000 })
        .toBe("chatwoot_live_chat_widget");
      // Mobile ではウィジェットが全画面になり、ページ側の閉じるボタンが隠れる。フォーカスは iframe の中にあるので
      // Esc はページ側の SDK に届かず閉じない。中のヘッダーの閉じるボタンは部分適合の対象なので、SDK の API で閉じる
      const close = page.locator(".woot-widget-bubble.woot--close");
      if (await close.isVisible()) await close.click();
      else
        await page.evaluate(() =>
          (window as unknown as { $chatwoot: { toggle(state: "close"): void } }).$chatwoot.toggle("close"),
        );
      await expect(launcher).toBeFocused({ timeout: 10_000 });
    });
  });

  test.describe("異常系", () => {
    test("入力: 同意しないとチャットの SDK を読み込まず、ランチャーも出ない", async ({ page }) => {
      const loaded: string[] = [];
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/packs/js/sdk.js") loaded.push(r.url());
      });
      await open(page, "/");
      await page.getByRole("button", { name: "同意しない" }).click();
      await page.waitForTimeout(2_000);
      expect(loaded).toEqual([]);
      await expect(page.locator(".woot-widget-bubble")).toHaveCount(0);
    });
  });
});
