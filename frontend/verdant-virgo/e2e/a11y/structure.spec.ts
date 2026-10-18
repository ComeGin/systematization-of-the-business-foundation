// 見出しと名前（計画書の検証 7。WCAG 1.3.1・2.4.6・4.1.2）。全ルート。
// - h1 が 1 つで、見出しの段が飛ばない（sr-only の見出しも数える）
//   Cookie バナーは DOM でスキップリンクの直後にあり、表示中はその h2 が h1 より前に出る（リードの決定 R-4。意図どおり）。
//   そのため表示中はバナーの見出しを除いて段を見て、バナーを閉じた後は h1 が最初の見出しであることを見る
// - ランドマークの役割と名前の組が重ならない
// - target="_blank" のすべてに新しいタブの告知（読み上げの文に「新しいタブ」）がある
// - iframe に title がある（予約の完了画面は Cal.com の iframe が差し込まれるのを待つ）
import { expect, test } from "../support/fixtures";
import {
  duplicateLandmarks,
  headingSkips,
  headings,
  iframesWithoutTitle,
  landmarks,
  newTabLinksWithoutNotice,
} from "../support/dom";
import { open } from "./axe";
import { NOT_FOUND_ROUTE, distRoutes } from "./routes";

// 告知の文は site-content/a11y.ts の NEW_TAB_NOTICE（「（新しいタブで開きます）」の案）。言い回しの揺れを許して「新しいタブ」で見る
const NEW_TAB = /新しいタブ/;

async function checkStructure(
  page: import("@playwright/test").Page,
  route: string,
) {
  await open(page, route);
  if (route === "/contact/thanks/") {
    await page
      .locator("iframe")
      .first()
      .waitFor({ state: "attached", timeout: 15_000 })
      .catch(() => {});
  }
  const list = await headings(page, "#cookie-banner");
  expect
    .soft(
      list.filter((h) => h.level === 1).map((h) => h.text),
      "h1",
    )
    .toHaveLength(1);
  expect.soft(headingSkips(list), "見出しの段の飛び").toEqual([]);
  expect
    .soft(duplicateLandmarks(await landmarks(page)), "ランドマークの重複")
    .toEqual([]);
  expect
    .soft(
      await newTabLinksWithoutNotice(page, NEW_TAB),
      "新しいタブの告知が無いリンク",
    )
    .toEqual([]);
  expect
    .soft(await iframesWithoutTitle(page), "title の無い iframe")
    .toEqual([]);
  // バナーを閉じた後は h1 が最初の見出し
  const decline = page.getByRole("button", { name: "同意しない" });
  if (await decline.isVisible()) await decline.click();
  expect.soft((await headings(page))[0]?.level, "バナーを閉じた後の最初の見出し").toBe(1);
}

test.describe("見出しと名前", () => {
  test.describe("正常系", () => {
    for (const route of distRoutes()) {
      test(`${route} の見出し・ランドマーク・新しいタブの告知・iframe の名前`, async ({
        page,
      }) => {
        await checkStructure(page, route);
      });
    }
  });

  test.describe("異常系", () => {
    test("サーバ: 存在しないパスの 404 ページも、見出し・ランドマーク・名前がそろう", async ({
      page,
    }) => {
      await checkStructure(page, NOT_FOUND_ROUTE);
    });

    test("入力: Mobile メニューを開いた間は、名前の付いたダイアログの中にナビが 1 つだけある", async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "mobile",
        "Mobile のメニューは mobile の project だけ",
      );
      await open(page, "/");
      await page.getByRole("button", { name: "メニューを開く" }).click();
      // showModal() の間は外側が inert になり支援技術に出ないので、ダイアログの中だけが読まれる
      const dialog = page.getByRole("dialog", { name: "メニュー" });
      await expect(dialog).toBeVisible();
      const names = await dialog
        .getByRole("navigation")
        .evaluateAll((navs) =>
          navs.map((n) => n.getAttribute("aria-label") ?? ""),
        );
      expect(names).toHaveLength(1);
      expect(names[0]).not.toBe("");
      expect(
        await page.evaluate(
          () =>
            !!document.querySelector("header")?.closest("[inert]") ||
            document.querySelector("dialog#mobile-menu")?.matches(":modal"),
        ),
        "外側が支援技術から外れている（モーダル）",
      ).toBe(true);
    });
  });
});
