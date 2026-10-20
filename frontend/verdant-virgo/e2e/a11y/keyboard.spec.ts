// キーボードの操作（計画書の検証 3。WCAG 2.1.1・2.1.2・2.4.1・2.4.3・2.4.7・2.4.11）。
// 1 ページの検査が重いので、テンプレートごとに 1 本のルートで回す（routes.ts の templateRoutes）。
// 「順序が見た目と合う」は、正の tabindex が無く Tab の順が DOM の順と一致することで確かめる（見た目との一致は Q2 の手動で見る）。
import { expect, test } from "../support/fixtures";
import { focusStep, markTabbables, walkFocus } from "../support/dom";
import { open } from "./axe";
import { NOT_FOUND_ROUTE, templateRoutes } from "./routes";

const routes = [...templateRoutes(), NOT_FOUND_ROUTE];

test.describe("キーボードの操作", () => {
  test.describe("正常系", () => {
    for (const route of routes) {
      test(`${route} は Tab で操作できる要素すべてに DOM の順で届き、フォーカスが見え、Cookie バナーに隠れない`, async ({
        page,
      }) => {
        // 1 キーごとにページの様子を読むので、要素の多い一覧（ブログ）は 30 秒を超える
        test.setTimeout(120_000);
        await open(page, route);
        const total = await markTabbables(page);
        const positive = await page
          .locator("[tabindex]:not([tabindex='0']):not([tabindex^='-'])")
          .count();
        expect(positive, "tabindex が正の要素").toBe(0);

        const steps = await walkFocus(page, total + 60);
        const indexes = steps.filter((s) => s.index >= 0).map((s) => s.index);
        // 届いた順が DOM の順（0, 1, 2, …）と一致し、取りこぼしが無い
        expect(indexes).toEqual([...Array(total).keys()]);
        expect
          .soft(
            steps
              .filter((s) => !s.visible && s.tag !== "iframe")
              .map((s) => `${s.tag}「${s.label}」${s.outline}`),
            "フォーカスが見えない",
          )
          .toEqual([]);
        expect
          .soft(
            steps
              .filter((s) => s.hiddenByBanner)
              .map((s) => `${s.tag}「${s.label}」`),
            "Cookie バナーに隠れる",
          )
          .toEqual([]);
      });
    }

    test("最初の Tab でスキップリンクに届き、Enter で #main にフォーカスが移る", async ({
      page,
    }) => {
      await open(page, "/");
      await page.keyboard.press("Tab");
      const skip = page.locator(":focus");
      await expect(skip).toHaveAttribute("href", "#main");
      await expect(skip).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.locator("main#main")).toBeFocused();
      // 次の Tab は本文の最初の操作できる要素（ヘッダーへ戻らない）
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => !!document.activeElement?.closest("main")),
      ).toBe(true);
    });

    test("Mobile メニューはボタンで開くとフォーカスが中に入り、Esc で閉じて開いたボタンに戻る", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Mobile のメニューは mobile の project だけ",
      );
      await open(page, "/");
      const opener = page.getByRole("button", { name: "メニューを開く" });
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.locator("dialog#mobile-menu");
      await expect(dialog).toHaveAttribute("open", "");
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest("dialog#mobile-menu"),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toHaveAttribute("open", "");
      await expect(opener).toBeFocused();
      await expect(opener).toHaveAttribute("aria-expanded", "false");
    });
  });

  test.describe("異常系", () => {
    test("入力: Shift+Tab で逆にたどると Tab と逆の順になる（キーボードのトラップが無い）", async ({
      page,
    }) => {
      // 正常系の一周と同じく、1 キーごとにページの様子を読むので 30 秒を超える
      test.setTimeout(120_000);
      await open(page, "/");
      const total = await markTabbables(page);
      // 最後の要素から逆にたどる
      await page.locator(`[data-e2e-tab="${total - 1}"]`).focus();
      const last = await focusStep(page);
      const steps = await walkFocus(page, total + 60, true);
      const indexes = [last?.index, ...steps.map((s) => s.index)].filter(
        (i): i is number => typeof i === "number" && i >= 0,
      );
      expect(indexes).toEqual([...Array(total).keys()].reverse());
    });

    test("入力: Mobile メニューを開いたまま Tab を押し続けてもメニューの外へ出ない", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Mobile のメニューは mobile の project だけ",
      );
      await open(page, "/");
      await page.getByRole("button", { name: "メニューを開く" }).click();
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate(() => {
          const el = document.activeElement;
          return (
            !el || el === document.body || !!el.closest("dialog#mobile-menu")
          );
        });
        expect(inside, `${i + 1} 回目の Tab`).toBe(true);
      }
    });
  });
});
