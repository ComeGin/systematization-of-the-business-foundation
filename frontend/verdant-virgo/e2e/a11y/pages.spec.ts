// 全ルートを axe で検査する（計画書の V1・検証 2）。
// 初回訪問の状態（Cookie バナーの表示中）のまま測る。クリック・送信はしない。
// 結果は期待の前に .a11y/pages/ へ書き、globalTeardown（merge.ts）が summary.json にまとめる。
import { expect, test } from "../support/fixtures";
import { audit, brief, open } from "./axe";
import { NOT_FOUND_ROUTE, distRoutes, sitemapPaths } from "./routes";

const routes = distRoutes();

test.describe("全ルートの axe 検査", () => {
  test.describe("正常系", () => {
    test("sitemap の URL はすべて dist のルートにある", () => {
      const missing = sitemapPaths().filter((p) => !routes.includes(p));
      expect(missing).toEqual([]);
    });

    test("sitemap に /accessibility/ と /sitemap/ が載る（計画書の検証 1）", () => {
      expect(sitemapPaths()).toEqual(
        expect.arrayContaining(["/accessibility/", "/sitemap/"]),
      );
    });

    test("/accessibility/ の試験結果の表は、JIS の 38 基準と追加の 18 基準の行を持つ", async ({
      page,
    }) => {
      await open(page, "/accessibility/");
      // Mobile では表を隠して h3 のまとまりに組み替えるので、HTML にある表の行を数える
      const rows = await page
        .locator("table")
        .evaluateAll((tables) =>
          tables.map((t) => t.querySelectorAll("tbody tr").length),
        );
      expect(rows).toEqual([38, 18]);
      // 各行のセルの数が列の見出しの数とそろう（結果・注記が空でも空のセルを出す。ずれると注記が「結果」の列に入る）
      const misaligned = await page.locator("table").evaluateAll((tables) =>
        tables.flatMap((t) => {
          const columns = t.querySelectorAll("thead th").length;
          return [...t.querySelectorAll("tbody tr")]
            .filter((tr) => tr.querySelectorAll("th, td").length !== columns)
            .map((tr) => `${tr.querySelector("th, td")?.textContent?.trim()}: ${tr.querySelectorAll("th, td").length}/${columns}`);
        }),
      );
      expect(misaligned).toEqual([]);
    });

    for (const route of routes) {
      test(`${route} に WCAG 2.2 AA までの違反が無い`, async ({
        page,
      }, testInfo) => {
        const { response, result } = await audit(
          page,
          testInfo,
          route,
          "default",
          () => open(page, route),
        );
        expect(response?.status()).toBe(200);
        expect(brief(result.violation_items)).toEqual([]);
      });
    }
  });

  test.describe("異常系", () => {
    test("サーバ: 存在しないパスで 404 ページが返り、違反が無い", async ({
      page,
    }, testInfo) => {
      const { response, result } = await audit(
        page,
        testInfo,
        NOT_FOUND_ROUTE,
        "default",
        () => open(page, NOT_FOUND_ROUTE),
      );
      expect(response?.status()).toBe(404);
      expect(brief(result.violation_items)).toEqual([]);
    });
  });
});
